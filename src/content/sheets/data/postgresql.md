---
title: PostgreSQL 速查
summary: psql 常用命令、备份恢复（pg_dump/pg_basebackup/PITR）、性能诊断（pg_stat_* 视图）、以及真空与索引维护。
group: Data
order: 1
tags: [postgresql, 数据库, 运维]
---

## 一、psql 快捷命令

```bash
psql -h host -U user -d dbname

# 库内元命令
\l            # 列出数据库
\c dbname     # 切换库
\dt           # 列出表
\d+ tablename # 表结构（含索引、约束）
\dn           # 列出 schema
\df           # 列出函数
\du           # 列出角色
\x            # 切换竖排显示（宽表必备）
\timing       # 显示执行时间
\e            # 用编辑器写长 SQL
\q            # 退出
```

## 二、连接与权限

```sql
-- 创建库与用户
CREATE DATABASE appdb OWNER appuser;
CREATE USER appuser WITH PASSWORD 'xxx';
GRANT CONNECT ON DATABASE appdb TO appuser;
GRANT USAGE ON SCHEMA public TO appuser;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO appuser;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO appuser;

-- 查看连接
SELECT count(*), state FROM pg_stat_activity GROUP BY state;
SELECT pid, usename, state, query_start, query
  FROM pg_stat_activity WHERE state <> 'idle'
  ORDER BY query_start LIMIT 10;

-- 终止某连接
SELECT pg_terminate_backend(pid);
```

## 三、配置（postgresql.conf）

```conf
listen_addresses = '*'
max_connections = 200
shared_buffers = 4GB              # 约内存的 25%
effective_cache_size = 12GB       # 约内存的 75%（优化器参考）
work_mem = 16MB                   # 每个排序/哈希操作
maintenance_work_mem = 512MB
wal_level = replica               # 需要复制/PITR
max_wal_size = 4GB
checkpoint_timeout = 15min
archive_mode = on
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'
log_min_duration_statement = 1000 # 记录 >1s 的 SQL
```

**`work_mem` 的坑**：

```
它是"每个操作"的额度，不是全局
并发 50 + 每个查询 3 个排序 → 可能用 50 × 3 × work_mem
设太大 → OOM
```

## 四、备份

```bash
# 逻辑备份（单库）
pg_dump -h host -U user -Fc appdb > appdb.dump

# 逻辑备份（全实例，含角色）
pg_dumpall -U postgres > all.sql

# 恢复
pg_restore -h host -U user -d appdb -j 4 appdb.dump

# 纯 SQL 导出（可读，但慢）
pg_dump -Fp appdb > appdb.sql
```

**`-Fc`（自定义格式）优于纯 SQL**：

```
支持并行恢复（-j）、支持选择性恢复（只恢复某张表）
```

```bash
pg_restore -l appdb.dump                # 列出内容
pg_restore -L list.txt ...              # 按清单选择性恢复
```

## 五、物理备份与 PITR

```bash
# 基础备份（在线，不锁表）
pg_basebackup -h host -U replicator -D /backup/base -Ft -z -P -X stream
```

**PITR（时间点恢复）的三个前提**：

```
① wal_level = replica（或 logical）
② archive_mode = on + archive_command
③ 有一份基础备份
```

**恢复步骤**：

```bash
# 1. 停库，清空数据目录
systemctl stop postgresql
rm -rf /var/lib/postgresql/data/*

# 2. 还原基础备份
tar -xzf /backup/base.tar.gz -C /var/lib/postgresql/data

# 3. 配置恢复目标
cat >> /var/lib/postgresql/data/postgresql.auto.conf <<'EOF'
restore_command = 'cp /archive/%f %p'
recovery_target_time = '2026-11-27 10:30:00'
recovery_target_action = 'promote'
EOF

# 4. 创建 recovery.signal（PG12+）
touch /var/lib/postgresql/data/recovery.signal

# 5. 启动
systemctl start postgresql
```

**验证恢复点**：

```sql
SELECT pg_is_in_recovery();    -- 恢复中为 true
-- 日志里看 "recovery stopping before ... " 与 "database system is ready"
```

## 六、性能诊断

```sql
-- 1. 最耗时的 SQL（需 pg_stat_statements 扩展）
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT calls, round(total_exec_time::numeric,2) AS total_ms,
       round(mean_exec_time::numeric,2) AS mean_ms, query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;

-- 2. 表膨胀与死元组
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup::numeric/NULLIF(n_live_tup,0)*100,2) AS dead_pct
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;

-- 3. 索引使用率（找出没被用过的索引）
SELECT relname, indexrelname, idx_scan
FROM pg_stat_user_indexes ORDER BY idx_scan ASC LIMIT 20;

-- 4. 缓存命中率
SELECT sum(blks_hit)*100.0/NULLIF(sum(blks_hit+blks_read),0) AS hit_pct
FROM pg_stat_database;

-- 5. 长事务（阻塞源头）
SELECT pid, now()-xact_start AS dur, state, query
FROM pg_stat_activity WHERE xact_start IS NOT NULL
ORDER BY dur DESC LIMIT 5;

-- 6. 锁等待
SELECT w.pid AS waiting, l.pid AS blocking, w.query
FROM pg_stat_activity w
JOIN pg_locks l1 ON l1.pid = w.pid AND NOT l1.granted
JOIN pg_locks l2 ON l2.locktype=l1.locktype AND l2.granted
JOIN pg_stat_activity l ON l.pid = l2.pid;
```

## 七、执行计划

```sql
EXPLAIN ANALYZE SELECT ...;
```

**看这几处**：

| 关键字 | 含义 | 处理 |
| --- | --- | --- |
| Seq Scan | 全表扫 | 加索引或改查询 |
| Nested Loop + 大行数 | 嵌套循环太贵 | 换 join 方式/加索引 |
| Sort (external) | 排序溢到磁盘 | 加 work_mem 或加索引 |
| Hash (spilled) | 哈希溢到磁盘 | 同上 |
| rows 估算偏差大 | 统计过期 | ANALYZE |

**"估算 rows 与实际差 10 倍以上"** → 先 `ANALYZE`，再看是否需要扩统计维度。

## 八、维护

```sql
-- 手动 vacuum（回收空间）
VACUUM VERBOSE tablename;
VACUUM FULL tablename;        -- 会锁表（重写整表），慎用
VACUUM ANALYZE tablename;     -- 回收 + 更新统计

-- 更新统计
ANALYZE tablename;

-- 重建索引（在线）
REINDEX INDEX CONCURRENTLY idx_name;
REINDEX TABLE CONCURRENTLY tablename;
```

**autovacuum 设置**：

```conf
autovacuum = on
autovacuum_naptime = 30s
autovacuum_max_workers = 4
autovacuum_vacuum_scale_factor = 0.1
autovacuum_analyze_scale_factor = 0.05
```

**大表建议按表调整**：

```sql
ALTER TABLE big_table SET (autovacuum_vacuum_scale_factor = 0.02);
```

**为什么**：默认 10% 死元组才触发，1 亿行的表要死 1000 万行才清理（太晚）。

## 九、复制

```conf
# 主库
wal_level = replica
max_wal_senders = 10
wal_keep_size = 1GB

# pg_hba.conf
host replication replicator 10.0.0.0/8 md5
```

```bash
# 从库初始化
pg_basebackup -h primary -U replicator -D /data -P -X stream -R
# -R 自动生成 standby.signal 与 primary_conninfo
```

```sql
-- 查看复制状态
SELECT client_addr, state, sent_lsn, replay_lsn,
       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS lag_bytes
FROM pg_stat_replication;

-- 从库
SELECT now() - pg_last_xact_replay_timestamp() AS lag;
```

## 十、常见故障

| 现象 | 排查 |
| --- | --- |
| 连接数打满 | `pg_stat_activity` 看来源；加连接池 |
| 慢查询 | `pg_stat_statements` + `EXPLAIN ANALYZE` |
| 表膨胀 | `n_dead_tup`；调 autovacuum 或手动 VACUUM |
| 复制延迟 | `pg_stat_replication` 的 lag_bytes；查网络/从库 IO |
| 主库不可写 | 磁盘满 / WAL 无法归档 |
| 索引失效 | 统计过期、类型不匹配（隐式转换） |

## 十一、检查清单

```bash
# 关键指标
psql -c "SELECT * FROM pg_stat_database WHERE datname='appdb';"
psql -c "SELECT count(*) FROM pg_stat_activity;"
psql -c "SELECT pg_size_pretty(pg_database_size('appdb'));"

# 备份是否在跑
ls -lh /backup/ | tail

# WAL 归档是否正常
ls -lt /archive/ | head

# 复制是否正常
psql -c "SELECT * FROM pg_stat_replication;"
```
