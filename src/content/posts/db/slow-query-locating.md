---
title: 慢查询定位：从慢日志到执行计划的完整链路
description: 定位慢 SQL 不是"看 EXPLAIN 就行"。先确认慢日志是否开着、抓的是不是真凶，再用执行计划与统计信息判断瓶颈在 CPU、I/O 还是锁。
date: 2026-10-29
tags: [MySQL, 慢查询, EXPLAIN, 优化, 数据库]
---

线上卡顿，第一反应是"数据库慢了"。但"慢"至少分三种：SQL 本身写得差、执行计划选错、等锁。三者处理方式完全不同。

## 一、先确认慢日志真的开着

```sql
SHOW VARIABLES LIKE 'slow_query_log%';
SHOW VARIABLES LIKE 'long_query_time';
SHOW VARIABLES LIKE 'log_queries_not_using_indexes';
```

`long_query_time` 默认 10s，线上建议 1s 甚至 0.5s；`log_queries_not_using_indexes` 打开后日志会暴增，只在排查期短期开启。

```sql
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 1;
SET GLOBAL slow_query_log_file = '/var/log/mysql/slow.log';
```

## 二、聚合分析，而不是逐条翻

```bash
# 用 mysqldumpslow 做初步聚合
mysqldumpslow -s c -t 20 /var/log/mysql/slow.log      # 按次数
mysqldumpslow -s t -t 20 /var/log/mysql/slow.log      # 按总耗时

# 更专业的 pt-query-digest（Percona Toolkit）
pt-query-digest /var/log/mysql/slow.log > slow-report.txt
```

看报告时关注三个数：**执行次数 × 单次平均耗时 = 总耗时**。一条 50ms 但每秒跑 1000 次的 SQL，比一条 3s 但一天跑 3 次的更值得优化。

## 三、EXPLAIN 该看哪几列

```sql
EXPLAIN FORMAT=JSON SELECT ...;
EXPLAIN ANALYZE SELECT ...;      -- 8.0.18+，给真实耗时与行数
```

| 列 | 关注点 |
| --- | --- |
| `type` | `const`/`eq_ref`/`ref` 好；`range` 可接受；`index` 是扫索引全表；`ALL` 是全表扫 |
| `key` | 实际用了哪个索引；`NULL` 说明没用上 |
| `rows` | 估算扫描行数，与实际差一个数量级说明统计信息过期 |
| `filtered` | 过滤比例，太低说明索引选择性差 |
| `Extra` | `Using filesort`、`Using temporary` 是重点，`Using index` 是好事 |

**`Using filesort` 不一定慢**：小结果集排序在内存里很快。真正的信号是 `rows` 很大且 `Using filesort` 同时出现，此时排序落盘，代价陡增。

## 四、三种典型瓶颈的判别

### 1. 计划选错（统计信息失真）

现象：同样的 SQL，昨天走索引今天全表。判断：

```sql
SELECT * FROM mysql.innodb_table_stats WHERE table_name='orders';
ANALYZE TABLE orders;
```

优化器估算行数来自统计信息（采样页），大批量写入后统计信息会偏。定期 `ANALYZE TABLE`，或对大表用 `innodb_stats_persistent` 持久化统计。

### 2. 锁等待（看起来"慢"，其实在排队）

```sql
-- 8.0 直接查阻塞关系
SELECT * FROM performance_schema.data_lock_waits\G
SELECT * FROM sys.innodb_lock_waits\G

-- 看当前事务与执行的语句
SELECT trx_id, trx_state, trx_started, trx_query FROM information_schema.innodb_trx;
```

如果 `trx_state` 是 `LOCK WAIT`，问题在长事务持有锁，不在 SQL 本身。找持有者：`sys.innodb_lock_waits` 的 `blocking_pid`。

### 3. 排序/临时表落盘

```sql
SHOW STATUS LIKE 'Created_tmp_disk_tables';
```

这个值增长快，说明有大量排序超出 `tmp_table_size`/`sort_buffer_size`。优先改 SQL（减少排序结果集），其次才是调参数。

## 五、优化动作的优先级

1. **改 SQL**：减少返回列、去掉函数包裹、拆大 IN、避免 `SELECT *`。
2. **加/改索引**：按上文的覆盖与最左前缀原则。
3. **拆查询**：大范围聚合拆成预聚合表或增量物化。
4. **调参数**：`innodb_buffer_pool_size`、连接池大小——这是最后一步，参数救不了烂 SQL。
5. **架构层**：读写分离、分库分表、缓存前置。

## 六、验证闭环

改完必须验证三件事：

- `EXPLAIN ANALYZE` 的实际耗时与扫描行数下降；
- 慢日志里这条 SQL 消失（或耗时进到 100ms 内）；
- **写入侧没有变慢**：对比 `SHOW GLOBAL STATUS LIKE 'Innodb_rows_inserted'` 与业务写入延迟。

> 一次真实案例：某订单查询 3s，`EXPLAIN` 显示 `type=ALL`。原因是 `WHERE user_id = ? AND status = 1 ORDER BY create_time DESC`，只建了 `(user_id)` 单列索引，排序要靠 filesort。改成 `(user_id, status, create_time)` 联合索引后，`Using index condition` + 索引有序直接输出，降到 8ms。**结论不是"加索引"，而是"索引要匹配 ORDER BY 的形状"。**
