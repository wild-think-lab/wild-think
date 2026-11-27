---
title: 实验：MySQL 主从复制从零搭到能切换
description: 两台机器、30 分钟，搭一套一主一从，验证延迟、模拟主库故障、手工提升从库，附完整命令与踩坑记录。
date: 2026-11-27
tags: [实验, MySQL, 主从复制, 高可用, 数据库]
---

### 实验目的

1. 搭起一主一从，复制状态为双 Yes。
2. 观察到复制延迟，并能解释原因。
3. 模拟主库宕机，手工把从库提升为主，业务侧改连接串后恢复。

### 环境

| 角色 | IP | 版本 | 配置 |
| --- | --- | --- | --- |
| 主库 db-m | 10.10.10.31 | MySQL 8.0.36 | 2C4G |
| 从库 db-s | 10.10.10.32 | MySQL 8.0.36 | 2C4G |
| 应用 | 10.10.10.40 | — | 测试连接用 |

系统 CentOS 7 / Rocky 9 均可，关闭 selinux 或放行 3306。

### 原理简述

1. 主库写 binlog。
2. 从库 IO 线程拉取 binlog 写入 relay log。
3. 从库 SQL 线程回放 relay log 到本地数据。

因此：**主库 binlog 丢失 = 复制中断且数据丢**；从库 `read_only` 只是防误写，不是安全边界。

### 步骤一：主库配置

```ini
# /etc/my.cnf.d/replication.cnf
[mysqld]
server_id = 31
log_bin = /var/lib/mysql/binlog
binlog_format = ROW
binlog_row_image = FULL
binlog_expire_logs_seconds = 604800
sync_binlog = 1
innodb_flush_log_at_trx_commit = 1
```

```bash
sudo systemctl restart mysqld
mysql -e "SELECT @@server_id, @@log_bin, @@binlog_format;"
```

### 步骤二：建复制账号

```sql
CREATE USER 'repl'@'10.10.10.%' IDENTIFIED WITH mysql_native_password BY 'Repl@2026';
GRANT REPLICATION SLAVE ON *.* TO 'repl'@'10.10.10.%';
```

MySQL 8 默认 `caching_sha2_password`，老版本从库可能不兼容，所以显式指定 `mysql_native_password`（生产按版本统一）。

### 步骤三：主库做一致性备份并传过去

```bash
# 不锁表的逻辑备份（InnoDB 用 --single-transaction）
mysqldump -uroot -p --single-transaction --master-data=2 \
  --routines --triggers --events --all-databases > /tmp/full.sql

scp /tmp/full.sql root@10.10.10.32:/tmp/
```

`--master-data=2` 会把 binlog 位点以注释写进备份文件头部：

```bash
head -30 /tmp/full.sql | grep CHANGE MASTER
# -- CHANGE MASTER TO MASTER_LOG_FILE='binlog.000003', MASTER_LOG_POS=1571;
```

记住这个位点，从库要用。

### 步骤四：从库配置并导入

```ini
[mysqld]
server_id = 32
relay_log = /var/lib/mysql/relay
read_only = ON
super_read_only = ON
log_slave_updates = ON
```

```bash
sudo systemctl restart mysqld
mysql -uroot -p < /tmp/full.sql
```

### 步骤五：建立复制

```sql
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST='10.10.10.31',
  SOURCE_USER='repl',
  SOURCE_PASSWORD='Repl@2026',
  SOURCE_LOG_FILE='binlog.000003',
  SOURCE_LOG_POS=1571;
START REPLICA;
SHOW REPLICA STATUS\G
```

### 验证

```sql
-- 主库
CREATE DATABASE lab;
CREATE TABLE lab.t(id INT PRIMARY KEY, v VARCHAR(20));
INSERT INTO lab.t VALUES (1,'hello');

-- 从库
SELECT * FROM lab.t;      -- 应能查到
SHOW REPLICA STATUS\G     -- 三个 Yes
```

`SHOW REPLICA STATUS` 必看四行：`Replica_IO_Running: Yes`、`Replica_SQL_Running: Yes`、`Seconds_Behind_Source: 0`、`Last_Error` 为空。

### 观察延迟

造一个慢回放：

```sql
-- 主库：一次插 5 万行（不要在生产做）
INSERT INTO lab.t SELECT seq, 'x' FROM (SELECT @row:=@row+1 AS seq FROM information_schema.columns a, information_schema.columns b LIMIT 50000) x;
```

从库上：

```bash
while true; do mysql -e "SHOW REPLICA STATUS\G" | grep -E 'Seconds_Behind|Exec_Master'; sleep 1; done
```

看到延迟上涨再回落，理解"大事务导致延迟"的直观感受。

### 故障切换演练（手工版）

1. 停主库：

```bash
sudo systemctl stop mysqld      # db-m
```

2. 从库确认已追平并提升：

```sql
-- 确保 Seconds_Behind_Source = 0
STOP REPLICA;
RESET REPLICA ALL;
SET GLOBAL read_only = OFF;
SET GLOBAL super_read_only = OFF;
```

3. 应用改连接串指向 10.10.10.32（配置中心改，别改代码）。
4. 原主库修好后，反向搭建（它变从库）。

### 踩坑记录

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Last_IO_Error: Access denied` | 账号或密码错，或 `caching_sha2` 不兼容 | 检查 `repl` 授权、认证插件 |
| `Replica_SQL_Running: No` + 1062 | 从库已有数据，主键冲突 | 重新做全量，`RESET REPLICA ALL` 后重建 |
| `server_id` 相同 | 两台都写 1 | 必须互不相同 |
| 切完没追平就提升 | 数据少一截 | 必须等 `Seconds_Behind_Source=0` |
| 主库 binlog 被 purge | 从库长期离线 | 保留期 ≥ 最长离线窗口 |

### 结论与下一步

这个实验建立的认知是：**复制不是备份，切换必须演练。** 生产上加 `MHA` / `Orchestrator` / `InnoDB Cluster` 做自动切换，但原理和这个手工流程完全一样——先追平、再提升、再改连接串。
