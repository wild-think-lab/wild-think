---
title: PostgreSQL 运维要点：和 MySQL 不一样的那些地方
description: 连接与内存模型、vacuum 与表膨胀、WAL 与归档、复制与逻辑订阅、以及 PG 上最容易误判的三个指标。
date: 2023-01-14
tags: [PostgreSQL, 数据库, 运维, 调优]
---

### 与 MySQL 的结构差异

| | MySQL | PostgreSQL |
| --- | --- | --- |
| 并发模型 | 每连接一线程 | 每连接一进程 |
| MVCC 实现 | undo log（就地更新） | 多版本行（旧版本留在表里） |
| 清理机制 | purge 线程 | autovacuum |
| 复制 | binlog（语句/行） | WAL 物理 + 逻辑解码 |
| 默认端口 | 3306 | 5432 |

两条直接影响运维的结论：

1. **PG 连接更贵**（每连接一个进程），必须用连接池（PgBouncer）。
2. **PG 会"表膨胀"**（旧版本行不被清理就占空间），必须管 autovacuum。

### 连接与内存

```conf
max_connections = 200
shared_buffers = 4GB              # 通常取内存 25%
effective_cache_size = 12GB       # 告诉优化器"可用缓存"，不是真分配
work_mem = 16MB                   # 每排序/哈希操作，注意是"每连接每操作"
maintenance_work_mem = 512MB      # vacuum/建索引用
```

`work_mem` 的陷阱：它不是"每连接"而是"每个操作节点"。一个复杂查询有 3 个排序 → 3 × work_mem × 连接数。设太大容易 OOM。

连接池：

```ini
# pgbouncer.ini
[databases]
app = host=127.0.0.1 port=5432 dbname=app

[pgbouncer]
pool_mode = transaction        # 事务级复用，效率最高
max_client_conn = 1000
default_pool_size = 50
```

`pool_mode=transaction` 的限制：不能用会话级特性（prepared statement 跨事务、临时表、`SET` 持久化）。需要这些时用 `session` 模式。

### vacuum 与表膨胀

PG 的更新是"写新行 + 旧行标记死"，死行要靠 vacuum 回收。

```sql
-- 看死行比例
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup::numeric / greatest(n_live_tup,1) * 100, 1) AS dead_pct,
       last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;
```

死行占比 > 20% 就该关注。

```conf
autovacuum = on
autovacuum_naptime = 30s
autovacuum_vacuum_scale_factor = 0.1      # 20% 死行触发（默认 0.2 太松）
autovacuum_vacuum_cost_limit = 2000       # 加快清理速度
```

**长事务是 vacuum 的天敌**：一个开了 3 小时的只读事务会阻止旧版本回收，导致表持续膨胀。

```sql
-- 找出长事务
SELECT pid, now() - xact_start AS dur, state, query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY dur DESC LIMIT 5;
```

需要彻底回收空间时用 `VACUUM FULL`（会锁表，生产慎用）或 `pg_repack`（在线重写）。

### WAL 与归档

```conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'
```

`archive_command` 返回非 0 会让 WAL 堆积填满磁盘——这是 PG 最经典的磁盘打满原因。

检查：

```sql
SELECT * FROM pg_stat_archiver;   -- failed_count 应长期为 0
```

备份组合：

```bash
# 基础备份
pg_basebackup -h 127.0.0.1 -D /backup/base -Ft -z -P
# 恢复：基础备份 + 重放 WAL 到目标时间点
restore_command = 'cp /archive/%f %p'
recovery_target_time = '2026-11-27 10:30:00'
```

这就是 PITR：能把数据库恢复到"误删之前那一秒"。

### 复制与逻辑订阅

**物理复制**（流复制）：

```conf
# 主库
wal_level = replica
max_wal_senders = 10
# 备库
primary_conninfo = 'host=10.0.0.1 port=5432 user=repl password=...'
hot_standby = on
```

**逻辑复制**（选择性同步某几张表）：

```sql
-- 发布端
CREATE PUBLICATION pub_order FOR TABLE orders, order_items;
-- 订阅端
CREATE SUBSCRIPTION sub_order
  CONNECTION 'host=publisher dbname=app'
  PUBLICATION pub_order;
```

逻辑复制的用途：跨版本升级、只同步部分表、多主写入（需谨慎）。

限制：不复制 DDL、序列、大对象；主键冲突会卡住复制。

### 三个容易误判的指标

**① `pg_stat_activity` 里大量 idle**

不是"空闲就没事"。要看 `state_change` 时间：idle 很久的连接可能是连接池泄漏；`idle in transaction` 是危险状态（占锁 + 阻止 vacuum）。

**② 缓存命中率 99% 就健康**

命中率由 `shared_buffers` 与访问模式决定。全表扫描多时命中率天然低，不代表有问题。要看的是**慢查询与 IO 等待**。

**③ `pg_stat_user_tables.seq_scan` 高就是坏事**

小表全扫比走索引快。要结合表大小看：`seq_scan` 高 + 表很大 + `seq_tup_read` 巨大才是问题。

### 慢查询定位

```conf
log_min_duration_statement = 500      # 记录 > 500ms
log_lock_waits = on
```

```sql
-- 需要 pg_stat_statements 扩展
SELECT calls, round(mean_exec_time::numeric,2) AS avg_ms,
       round(total_exec_time::numeric) AS total_ms, query
FROM pg_stat_statements
ORDER BY total_exec_time DESC LIMIT 10;
```

按 `total_exec_time` 排序比按平均耗时更有价值：**总时间才是用户感受到的慢**。
