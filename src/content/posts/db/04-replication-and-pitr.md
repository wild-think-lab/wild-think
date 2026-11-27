---
title: MySQL 主从复制与备份恢复：能回滚才算有数据库
description: binlog 三种格式、主从搭建的六个关键参数、延迟与不一致排查，以及一次完整的 xtrabackup + binlog 时间点恢复。
date: 2022-01-02
tags: [MySQL, 主从复制, 备份, binlog, 恢复]
---

### 先定一个基线

数据库的三件保命装备：

1. **全量备份**（每周或每天），可恢复。
2. **binlog 持续保留**（不少于 7 天），支持按时间点恢复。
3. **一个从库**，用于读扩展 + 备份落地 + 故障切换。

缺任何一件，"删库跑路"就从段子变成事故。

### binlog 三种格式

| 格式 | 记录内容 | 优点 | 缺点 |
| --- | --- | --- | --- |
| STATEMENT | SQL 语句 | 日志小 | 含 `NOW()`、`UUID()` 的函数会不一致 |
| ROW | 行变更前后镜像 | 主从强一致，可做闪回 | 日志大 |
| MIXED | 自动切换 | 折中 | 排查复杂 |

生产建议 **ROW + `binlog_row_image=FULL`**，配合 `binlog2sql` / `my2sql` 可以做误删闪回。

```ini
[mysqld]
server_id = 1
log_bin = /var/lib/mysql/binlog
binlog_format = ROW
binlog_row_image = FULL
binlog_expire_logs_seconds = 604800    # 7 天
sync_binlog = 1
```

### 搭建主从：六个必须对齐的参数

```ini
# 主库
server_id = 1
log_bin = /var/lib/mysql/binlog
binlog_format = ROW

# 从库
server_id = 2
relay_log = /var/lib/mysql/relay
read_only = ON
log_slave_updates = ON
```

`server_id` 重复是"复制建不起来"的第一大原因，两边必须不同。

步骤：

```sql
-- 主库：建复制账号并授权
CREATE USER 'repl'@'10.10.10.%' IDENTIFIED BY '***';
GRANT REPLICATION SLAVE ON *.* TO 'repl'@'10.10.10.%';

-- 主库：取一致性位点（推荐 mysqldump --single-transaction，不锁表）
-- FLUSH TABLES WITH READ LOCK; SHOW MASTER STATUS; UNLOCK TABLES;
```

```sql
-- 从库
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST='10.10.10.10', SOURCE_USER='repl',
  SOURCE_PASSWORD='***', SOURCE_AUTO_POSITION=1;
START REPLICA;
SHOW REPLICA STATUS\G
```

重点看三行：`Replica_IO_Running: Yes`、`Replica_SQL_Running: Yes`、`Seconds_Behind_Source`。

### 复制延迟与不一致

```sql
SHOW REPLICA STATUS\G   -- 关注 Seconds_Behind_Source
SHOW PROCESSLIST;       -- 看 SQL 线程在跑什么
```

延迟常见原因：

- 大事务（一次更新 50 万行 → 从库追很久）。拆批提交。
- 从库无索引，`ROW` 回放做全表扫描。
- 从库被报表查询打满 IO。
- 单线程回放（5.7 之后可开并行复制 `replica_parallel_workers`）。

数据不一致排查（用 pt-table-checksum）：

```bash
pt-table-checksum --host=10.10.10.10 --databases=app --replicate=percona.checksums
pt-table-sync --print --replicate=percona.checksums h=10.10.10.10
```

先 `--print` 看差异，别直接执行修复。

### xtrabackup 全量 + binlog 时间点恢复

```bash
# 全备（在线，不锁表）
xtrabackup --backup --target-dir=/backup/full --user=root --password=***

# 恢复前 prepare（回放 redo，使数据一致）
xtrabackup --prepare --target-dir=/backup/full

# 停库后恢复
systemctl stop mysqld
rm -rf /var/lib/mysql/*
xtrabackup --copy-back --target-dir=/backup/full
chown -R mysql:mysql /var/lib/mysql
systemctl start mysqld
```

假设 14:30 误删了一张表，全备是昨天 02:00：

```bash
# 1. 恢复到全备点（上面步骤）
# 2. 用 binlog 回放到 14:29:59
mysqlbinlog --start-datetime="2026-11-26 02:00:00" \
            --stop-datetime="2026-11-27 14:29:59" \
            /backup/binlog/binlog.000012 | mysql -uroot -p
```

这就是所谓的 **PITR（时间点恢复）**。前提：binlog 没被清、备份介质没和数据库一起挂。

### 备份的三条硬规则

1. **备份必须能恢复**：每月挑一台机器演练一次，记录耗时。
2. **备份不能和生产在同一存储**：否则一次磁盘故障全没。
3. **备份失败必须告警**：`xtrabackup` 退出码非 0 就该有人看。

### 检查清单

```bash
# 备份产物是否完整
ls -lh /backup/full/xtrabackup_checkpoints
cat /backup/full/xtrabackup_checkpoints      # 看 backup_type=full-backuped

# binlog 是否在
mysql -e "SHOW BINARY LOGS;"

# 复制是否健康
mysql -e "SHOW REPLICA STATUS\G" | egrep 'Running|Seconds_Behind'
```

数据库运维的核心不是调参，是"**任何一次误操作都能在 30 分钟内回到昨天**"。把这条做到，剩下的优化才有意义。
