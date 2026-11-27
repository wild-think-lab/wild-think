---
title: MySQL 排障与调优速查
summary: 慢查询怎么定位、EXPLAIN 每一列看什么、锁等待怎么查、连接数与缓冲池、常用诊断语句与备份恢复一条龙。
group: 数据
order: 7
tags: [MySQL, SQL, 性能, 排障]
---

## 先确认"慢在哪"

```sql
SHOW GLOBAL STATUS LIKE 'Questions';
SHOW GLOBAL STATUS LIKE 'Threads_connected';
SHOW GLOBAL STATUS LIKE 'Threads_running';
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read%';   -- 命中率
SHOW ENGINE INNODB STATUS\G                            -- 锁与事务段的原始现场
```

`Threads_running` 持续偏高 = 有慢语句在压着；`buffer_pool_reads`（物理读）占比高 = 缓冲池不够或访问模式随机。

## 慢查询日志

```sql
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 0.5;
SET GLOBAL log_queries_not_using_indexes = OFF;   -- 开了会刷屏
SHOW VARIABLES LIKE 'slow_query_log_file';
```

用 `pt-query-digest` 聚合，比一条条看有效：

```bash
pt-query-digest /var/lib/mysql/slow.log | head -60
```

它按"总耗时 × 次数"排序，能直接告诉你哪条语句在吃数据库。

## EXPLAIN 每列看什么

```sql
EXPLAIN ANALYZE
SELECT o.id, o.amount FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.created_at > '2026-11-01' AND u.city = '石家庄';
```

| 列 | 关注点 |
| --- | --- |
| `type` | `ALL` 全表扫最差；`index` 走索引但扫全索引；`range`/`ref`/`eq_ref` 正常 |
| `key` | 实际用的索引，`NULL` 表示没用上 |
| `rows` | 预估扫描行数，大得离谱说明统计信息旧或条件写错 |
| `filtered` | 过滤后剩余比例，低说明扫了很多废行 |
| `Extra` | `Using filesort` / `Using temporary` 是要优化的信号；`Using index` 是覆盖索引（好） |

`EXPLAIN ANALYZE`（8.0.18+）会真跑一遍并给实际耗时，比单纯 `EXPLAIN` 准。

## 索引失效的常见原因

1. 条件列上做了运算或函数：`WHERE DATE(created_at) = '2026-11-27'` → 改成范围查询。
2. 隐式类型转换：`WHERE user_id = '123'`（列是 int）会掉索引，反之亦然。
3. 前导模糊：`LIKE '%abc'`。
4. 复合索引没用最左列。
5. `OR` 连接的两边只有一边有索引。
6. 排序字段与索引顺序不一致，导致 filesort。

## 锁与事务

```sql
SELECT * FROM performance_schema.data_locks;
SELECT * FROM performance_schema.data_lock_waits\G
SELECT * FROM information_schema.innodb_trx ORDER BY trx_started;
```

判断"谁在等谁"：

```sql
SELECT
  r.trx_id AS waiting_trx,
  r.trx_mysql_thread_id AS waiting_thread,
  b.trx_id AS blocking_trx,
  b.trx_mysql_thread_id AS blocking_thread,
  b.trx_query AS blocking_query
FROM information_schema.innodb_trx r
JOIN performance_schema.data_lock_waits w ON w.requesting_engine_transaction_id = r.trx_id
JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_engine_transaction_id;
```

拿到 `blocking_thread` 后用 `SHOW PROCESSLIST` 找到具体语句。长事务是锁等待的头号原因，先找"开了事务却不提交"的那段代码。

## 连接与容量

```sql
SHOW VARIABLES LIKE 'max_connections';
SHOW STATUS LIKE 'Max_used_connections';
SHOW PROCESSLIST;                     -- 或 SELECT * FROM information_schema.processlist
```

`Max_used_connections` 接近 `max_connections` 说明连接池配置过大或连接泄漏。盲目调大 `max_connections` 会让内存和上下文切换一起爆。

## 缓冲池与关键参数

```ini
innodb_buffer_pool_size = 60%物理内存   # 单实例专用机可到 70%
innodb_buffer_pool_instances = 8        # 大池分实例减少争用
innodb_flush_log_at_trx_commit = 1      # 1 最安全，2 性能好但可能丢 1 秒
innodb_io_capacity = 2000               # SSD 可调高
innodb_log_file_size = 1G               # 太小会导致频繁 checkpoint
tmp_table_size = 64M
max_allowed_packet = 64M
```

## 备份与恢复

```bash
# 逻辑备份（小库、迁移首选）
mysqldump --single-transaction --quick --routines --triggers \
  -h127.0.0.1 -uroot -p db_name | gzip > db_$(date +%F).sql.gz

# 物理备份（大库用 xtrabackup，不停机）
xtrabackup --backup --target-dir=/backup/full --user=root --password=xxx
xtrabackup --prepare --target-dir=/backup/full

# 恢复
gunzip < db_2026-11-27.sql.gz | mysql -uroot -p db_name
```

`--single-transaction` 保证 InnoDB 一致性快照且不锁表，但**不适用 MyISAM**。

恢复演练至少验证三件事：表数量、关键表行数、`CHECKSUM TABLE` 或业务抽样查询。

## 一条龙检查清单

```sql
-- 库/表体积
SELECT table_schema, ROUND(SUM(data_length+index_length)/1024/1024,1) AS mb
FROM information_schema.tables GROUP BY table_schema ORDER BY mb DESC;

-- 没主键的表（隐患）
SELECT table_schema, table_name FROM information_schema.tables
WHERE table_schema NOT IN ('mysql','sys','information_schema','performance_schema')
  AND table_name NOT IN (SELECT table_name FROM information_schema.table_constraints
                         WHERE constraint_type='PRIMARY KEY' AND table_schema=t.table_schema);
```
