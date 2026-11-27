---
title: MySQL 排障速查
summary: 连接、慢查询、锁等待、主从、空间与崩溃恢复，六类现象对应六组命令，附各字段判读。
group: 数据
order: 2
tags: [mysql, 排障, 数据库]
---

## 一、连不上

```bash
mysqladmin -h 10.0.0.10 -u root -p ping
mysql -h 10.0.0.10 -u app -p -e 'SELECT 1'
```

| 报错 | 原因 |
| --- | --- |
| `Can't connect ... (111)` | 服务没起 / 端口没监听 |
| `(2003)` 但本机能连 | `bind-address` 只绑了 127.0.0.1，或防火墙 |
| `Access denied for user` | 账号/密码/来源 host 不匹配（`'app'@'%'` vs `'app'@'10.%'`） |
| `Too many connections` | `max_connections` 打满或连接泄漏 |
| `Host is blocked` | `max_connect_errors` 触发（`FLUSH HOSTS` 解除） |
| `Authentication plugin ... cannot be loaded` | 8.0 默认 caching_sha2，老客户端不支持 |

```sql
SHOW VARIABLES LIKE 'max_connections';
SHOW STATUS LIKE 'Threads_connected';
SHOW PROCESSLIST;                       -- 谁在连
SELECT user, host, plugin FROM mysql.user;
FLUSH HOSTS;
```

## 二、慢查询

```sql
SHOW VARIABLES LIKE 'slow_query%';
SHOW VARIABLES LIKE 'long_query_time';

SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 1;
SET GLOBAL log_queries_not_using_indexes = ON;   -- 谨慎，日志会暴涨
```

分析：

```bash
mysqldumpslow -s t -t 10 /var/log/mysql/slow.log     # 按总耗时
pt-query-digest /var/log/mysql/slow.log              # 更详细（percona-toolkit）
```

单条语句：

```sql
EXPLAIN ANALYZE SELECT ...;              -- 8.0 真实执行统计
EXPLAIN SELECT ...;                      -- 估算
SHOW WARNINGS;                           -- 看优化器改写
```

**EXPLAIN 关键列**：

| 列 | 判读 |
| --- | --- |
| `type` | `ALL`（全表）最差，`index`/`range`/`ref`/`eq_ref` 逐步变好 |
| `key` | 为 NULL = 没用索引 |
| `rows` | 预估扫描行数，越大越慢 |
| `Extra` | `Using filesort`/`Using temporary` 要警惕 |

## 三、锁等待

```sql
-- 8.0
SELECT * FROM performance_schema.data_lock_waits;
SELECT * FROM performance_schema.data_locks;
-- 当前谁在等谁
SELECT r.trx_id waiting_trx, b.trx_id blocking_trx, b.trx_mysql_thread_id blocking_thread
FROM performance_schema.data_lock_waits w
JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_engine_transaction_id
JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_engine_transaction_id;

SHOW ENGINE INNODB STATUS\G            -- 搜 "LATEST DETECTED DEADLOCK"
```

处置：

```sql
KILL <thread_id>;                       -- 杀长事务（先确认是只读的）
```

**锁等待的常见根因**：长事务（事务里做了 HTTP 调用、批量更新）、无索引的更新（锁全表）、隔离级别过高。

## 四、主从

```sql
SHOW SLAVE STATUS\G
```

| 字段 | 判读 |
| --- | --- |
| `Slave_IO_Running` | `Connecting` = 连不上主库（网络/账号） |
| `Slave_SQL_Running` | `No` = 回放出错，看 `Last_SQL_Error` |
| `Seconds_Behind_Master` | 会骗人，看位置差更准 |
| `Read_Master_Log_Pos` vs `Exec_Master_Log_Pos` | 差值 = 积压量 |
| `Last_IO_Error` / `Last_SQL_Error` | 真正的原因在这里 |

常见修复：

```sql
-- 跳过一条错误（危险，确认后再做）
SET GLOBAL sql_slave_skip_counter = 1;
START SLAVE;

-- GTID 模式下
SET GTID_NEXT='<err-gtid>';
BEGIN; COMMIT;
SET GTID_NEXT='AUTOMATIC';
START SLAVE;
```

## 五、空间不释放 / 磁盘满

```sql
SELECT table_schema, ROUND(SUM(data_length+index_length)/1024/1024,1) AS mb
FROM information_schema.tables GROUP BY table_schema ORDER BY mb DESC;

SELECT table_name, ROUND(data_length/1024/1024,1) data_mb,
       ROUND(data_free/1024/1024,1) free_mb, engine
FROM information_schema.tables
WHERE table_schema='db' ORDER BY data_free DESC LIMIT 10;
```

```bash
# binlog 占用
mysql -e "SHOW BINARY LOGS;"
PURGE BINARY LOGS BEFORE DATE_SUB(NOW(), INTERVAL 7 DAY);
# 或设自动清理
mysql -e "SET GLOBAL binlog_expire_logs_seconds = 604800;"   # 7 天
```

**`data_free` 大但空间不降**：InnoDB 不会自动归还操作系统，需要 `OPTIMIZE TABLE`（会锁表/重建，用 pt-online-schema-change）。

## 六、崩溃与恢复

```bash
# 启动失败时先看错误日志
tail -100 /var/log/mysql/error.log
```

| 报错 | 处置 |
| --- | --- |
| `InnoDB: Database page corruption` | 从备份恢复；`innodb_force_recovery=1..6` 尝试导出数据 |
| `Cannot allocate memory` | buffer pool 太大 / 系统内存不足 |
| `Disk full` | 清 binlog、扩盘 |
| `Another process is using ...` | 有残留 pid/socket，确认无进程后删除 |

```ini
# 应急只读模式（抢数据用）
[mysqld]
innodb_force_recovery = 3
```

**用完必须删掉这行**，否则写入会继续损坏。

## 七、性能体检五条 SQL

```sql
-- 1. 连接与 QPS
SHOW GLOBAL STATUS WHERE Variable_name IN ('Questions','Uptime','Threads_running');

-- 2. 慢查询数量
SHOW GLOBAL STATUS LIKE 'Slow_queries';

-- 3. 全表扫描
SHOW GLOBAL STATUS LIKE 'Select_scan';

-- 4. InnoDB 缓冲池命中率
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read%';

-- 5. 临时表落盘
SHOW GLOBAL STATUS LIKE 'Created_tmp%';
```

判据：

| 指标 | 健康 |
| --- | --- |
| `Innodb_buffer_pool_reads / read_requests` | < 1% |
| `Created_tmp_disk_tables / Created_tmp_tables` | < 25% |
| `Threads_running` | 个位数（持续高说明有阻塞） |
| `Slow_queries` 增速 | 接近 0 |

## 八、备份与恢复（最小可用）

```bash
# 逻辑备份（小库）
mysqldump --single-transaction --routines --triggers -u root -p db > db.sql
# 恢复
mysql -u root -p db < db.sql

# 物理备份（大库，需要 xtrabackup）
xtrabackup --backup --target=/backup/full -u root -p
xtrabackup --prepare --target=/backup/full
xtrabackup --copy-back --target=/backup/full
```

**`--single-transaction` 是 InnoDB 在线备份的关键**（不加会锁表）。
