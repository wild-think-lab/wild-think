---
title: PostgreSQL 调优：从默认配置到"能撑住业务"
description: shared_buffers、work_mem、连接数、autovacuum、WAL 与检查点，五个必改项与五个误配。
date: 2026-03-08
tags: [PostgreSQL, 数据库, 调优]
---

### 默认配置的问题

```
PostgreSQL 的默认值来自 1990 年代（为了能在小机器上跑）
shared_buffers = 128MB、work_mem = 4MB、max_connections = 100
→ 在现代机器上是一种浪费
```

**但"照抄网上的大值"更危险**（超出内存会 OOM）。

### 五个必改项

```conf
# postgresql.conf
shared_buffers = 25% of RAM          # 8G 机器 → 2GB
effective_cache_size = 50-75% of RAM # 告诉优化器"有多少缓存可用"
work_mem = 64MB                      # 每个排序/哈希操作可用（注意是"每操作"）
maintenance_work_mem = 512MB         # VACUUM/CREATE INDEX 用
max_connections = 200                # 但要配合连接池
```

**`work_mem` 的危险性**：

```
不是"全局 64MB"，而是"每个排序/哈希节点 64MB"
一个复杂查询有 5 个排序 × 20 个并发 = 6.4GB
```

**这就是"调大 work_mem 后 OOM"的原因**。

**`effective_cache_size` 不影响真实分配**，只是"告诉优化器"（用于选择索引 vs 全表扫）。

### 连接数：最常被误判的地方

```
PostgreSQL 是"每连接一个进程"
max_connections = 500 → 500 个进程 → 上下文切换与内存压力
```

**正确做法**：

```
① 应用侧用连接池（如 PgBouncer）
② 数据库的 max_connections 保持较小（100–200）
③ 池的 transaction 模式能大幅提升连接复用
```

**PgBouncer 的三种模式**：

```
session     ：连接在会话期间占用（兼容性最好）
transaction ：每事务归还（复用高，但 prepared statement 受限）
statement   ：每语句归还（复用最高，限制最多）
```

**推荐 `transaction` 模式**（多数应用可用）。

### autovacuum：不配就会"表越来越大"

```conf
autovacuum = on
autovacuum_max_workers = 4
autovacuum_naptime = 10s
autovacuum_vacuum_scale_factor = 0.05     # 默认 0.2（20% 变化才清理）
autovacuum_analyze_scale_factor = 0.02
```

**为什么重要**：

```
PostgreSQL 的 UPDATE 是"标记旧行 + 插入新行"
→ 旧行占空间（死元组）
→ 不清理 → 表膨胀 → 查询变慢（要扫更多页）
```

**"表膨胀"是 PostgreSQL 特有的性能问题**：

```sql
-- 查看死元组
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup::numeric / NULLIF(n_live_tup,0) * 100, 2) AS dead_pct
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;
```

**`dead_pct > 10%`** 说明需要关注。

**大表单独设置参数**：

```sql
ALTER TABLE big_table SET (autovacuum_vacuum_scale_factor = 0.02);
```

### WAL 与检查点

```conf
wal_level = replica                  # 需要复制/逻辑解码时
max_wal_size = 4GB                   # 默认 1GB（太小 → 检查点太频繁）
min_wal_size = 1GB
checkpoint_completion_target = 0.9   # 把检查点写分散（平滑 IO）
wal_buffers = 64MB
```

**为什么 `max_wal_size` 要大**：

```
太小 → 检查点频繁 → 每次检查点都要刷大量脏页 → IO 尖刺
```

**"周期性 IO 卡顿"往往与检查点有关**。

### 查询计划与统计

```sql
ANALYZE;                    -- 更新统计（优化器依赖它）
ANALYZE VERBOSE mytable;

-- 查看表统计是否陈旧
SELECT relname, last_analyze, last_autoanalyze FROM pg_stat_user_tables;
```

**"索引明明有但没走"** 常因为统计过期（尤其大批量导入后）。

### 五个常被误配的参数

**① `work_mem` 设成 1GB**

```
并发一上来就 OOM
→ 按"总内存 / (最大并发 × 每查询排序数)"算
```

**② `shared_buffers` 设成 80%**

```
留给 OS page cache 的太少 → 文件读写变慢
→ 25%–40% 是常见区间
```

**③ `max_connections` 设成 2000**

```
每连接一个进程 → 内存与调度压力
→ 用连接池，数据库侧保持小
```

**④ 关闭 `synchronous_commit` 求性能**

```conf
synchronous_commit = off    # 提交不等 WAL 落盘
```

**代价**：机器崩溃时可能丢最后几个事务（不是"数据损坏"，是"丢失"）。

**只适合"可丢"的场景**（日志、统计），**不适合订单/支付**。

**⑤ `fsync = off`**

```
极度危险：崩溃可能导致数据文件损坏（不只是丢事务）
→ 任何生产环境都不要关
```

### 慢查询排查

```sql
-- 开启扩展
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

```conf
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max = 10000
pg_stat_statements.track = all
```

```sql
-- 按总耗时排序
SELECT calls, round(total_exec_time::numeric,2) total_ms,
       round(mean_exec_time::numeric,2) mean_ms, rows, query
FROM pg_stat_statements
ORDER BY total_exec_time DESC LIMIT 10;

-- 单条执行计划
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
```

**`BUFFERS` 很重要**：

```
shared hit=... ：命中缓存
shared read=...：真读磁盘
→ read 很大说明缓存不够或数据量太大
```

### 索引的坑

```sql
-- 找出没被用过的索引
SELECT indexrelname, idx_scan FROM pg_stat_user_indexes
WHERE idx_scan = 0 ORDER BY indexrelname;
```

**注意**：

```
idx_scan=0 可能是"统计重置后还没被用"，不要立刻删
要观察一段时间（比如一周以上）
```

**"索引太多"的代价**：

```
写变慢（每个索引都要维护）
磁盘变大
```

### 检查清单

```
□ shared_buffers 25%–40%
□ effective_cache_size 50%–75%
□ work_mem 按并发算（不要给太大）
□ 用 PgBouncer（transaction 模式）
□ max_connections 保持 100–200
□ autovacuum 参数收紧（大表单独设）
□ max_wal_size 调大（减少检查点频率）
□ checkpoint_completion_target = 0.9
□ 开 pg_stat_statements 并定期看
□ 大批量导入后 ANALYZE
□ 监控死元组比例
□ 不用 fsync=off、慎用 synchronous_commit=off
```
