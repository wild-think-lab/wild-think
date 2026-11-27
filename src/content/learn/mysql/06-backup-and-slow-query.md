---
title: 备份与慢查询：让数据库能被救、能被优化
module: 进阶篇
summary: mysqldump 与 xtrabackup 怎么选、binlog 时间点恢复的完整流程、慢查询怎么变成可行动的三步。
minutes: 13
---

### 备份的三件套

| 手段 | 特点 | 用途 |
| --- | --- | --- |
| 逻辑备份（mysqldump） | 可读、体积大、慢 | 小库、迁移、单表恢复 |
| 物理备份（xtrabackup） | 快、体积小 | 生产全量 |
| binlog | 记录每次变更 | 时间点恢复（PITR） |

**只有全量备份没有 binlog，做不到"回到昨天 14:29"。**

### mysqldump：小库与单表

```bash
mysqldump -uroot -p --single-transaction --routines --triggers \
  --master-data=2 shop > /backup/shop-$(date +%F).sql

# 单表恢复
mysql -uroot -p shop < shop-orders-2026-11-27.sql
```

`--single-transaction` 对 InnoDB 不锁表，是生产必备。`--master-data=2` 会把 binlog 位点写进文件头，PITR 时要用。

### xtrabackup：生产全量

```bash
xtrabackup --backup --target-dir=/backup/full --user=root --password=***
xtrabackup --prepare --target-dir=/backup/full     # 回放 redo，使数据一致

systemctl stop mysqld
rm -rf /var/lib/mysql/*
xtrabackup --copy-back --target-dir=/backup/full
chown -R mysql:mysql /var/lib/mysql
systemctl start mysqld
```

`--prepare` 不能省：没回放的备份数据是不一致的（相当于断电状态）。

### 时间点恢复（PITR）完整流程

场景：14:30 有人误删了一张表。

```bash
# 1. 恢复到最近的全备点（上面步骤）
# 2. 从全备时间点回放到 14:29:59
mysqlbinlog --start-datetime="2026-11-26 02:00:00" \
            --stop-datetime="2026-11-27 14:29:59" \
            /var/lib/mysql/binlog.000012 | mysql -uroot -p
```

前提条件（都要提前配）：

```ini
log_bin = /var/lib/mysql/binlog
binlog_format = ROW
binlog_row_image = FULL
binlog_expire_logs_seconds = 604800    # 7 天
```

### 备份的三条硬规则

1. **必须演练恢复**：每月随机挑一个库恢复到临时实例，记录耗时。
2. **备份不与生产同存储**：一次磁盘故障不该带走两份数据。
3. **失败必须告警**：脚本返回非 0 就该有人看。

```bash
#!/usr/bin/env bash
set -euo pipefail
mysqldump -uroot -p"$PASS" --single-transaction --all-databases \
  | gzip > /backup/all-$(date +%F).sql.gz
[ -s /backup/all-$(date +%F).sql.gz ] || { echo "备份为空"; exit 1; }
```

`-s` 判空这一步很关键：磁盘满时 mysqldump 会"成功"写出一个 0 字节文件。

### 慢查询：从日志到行动

**第一步：开启**

```ini
slow_query_log = 1
long_query_time = 1
log_queries_not_using_indexes = 0    # 先关，否则日志爆炸
```

**第二步：排序**

```bash
mysqldumpslow -s t -t 10 /var/log/mysql/slow.log
# 或更详细（需安装 percona-toolkit）
pt-query-digest /var/log/mysql/slow.log | head -60
```

**第三步：处理**

| 症状 | 动作 |
| --- | --- |
| `type=ALL`，rows 巨大 | 加索引或改条件 |
| `Using filesort` | 让 ORDER BY 走索引 |
| `Using temporary` | 拆查询或预聚合 |
| 单条查询返回大结果集 | 改分页、加缓存 |
| 都是小查询但总量大 | 连接池、缓存、或接口 N+1 |

### 监控该看的指标

```sql
SHOW GLOBAL STATUS LIKE 'Questions';
SHOW GLOBAL STATUS LIKE 'Threads_connected';
SHOW GLOBAL STATUS LIKE 'Slow_queries';
SHOW GLOBAL STATUS LIKE 'Innodb_row_lock_waits';
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_reads';
```

- `Threads_connected / max_connections > 70%`：连接数告警。
- `Slow_queries` 持续上涨：SQL 质量在退化。
- `Innodb_buffer_pool_reads` 高：缓存不够，正在读磁盘。

### 一条能落地的运维节奏

| 频率 | 做什么 |
| --- | --- |
| 每天 | 检查备份产物大小、复制状态 |
| 每周 | 看慢查询 Top 10，处理 1–2 条 |
| 每月 | 恢复演练一次；检查索引冗余 |
| 每季 | 参数复盘（buffer pool、连接数、超时） |
| 长期 | 所有 DDL 走审核，禁止手工改生产表 |

### 本章验证

1. 做一次全量备份，然后删一张表，用 binlog 恢复到删除前一秒。
2. 打开慢查询日志，制造一条 2 秒的查询，用 `pt-query-digest` 找到它。
3. 用 `SHOW GLOBAL STATUS` 算出当前连接使用率。

数据库运维的终极标准只有一句：**任何一次误操作，都能在 30 分钟内回到出事前一秒。**
