---
title: PostgreSQL 备份与 PITR：能回到"删库前一秒"吗
description: 逻辑备份与物理备份的差别、WAL 归档怎么配、PITR 完整步骤与验证、以及备份策略的成本与恢复目标。
date: 2024-01-22
tags: [PostgreSQL, 备份, PITR, 数据库]
---

### 两种备份

| | 逻辑（pg_dump） | 物理（pg_basebackup + WAL） |
| --- | --- | --- |
| 产物 | SQL 文本/自定义格式 | 数据目录的副本 + WAL |
| 大小 | 小（压缩后） | 大（等于数据目录） |
| 恢复速度 | 慢（要重放 SQL、重建索引） | 快 |
| 能否 PITR | **不能**（只能恢复到备份时点） | **能**（恢复到任意时刻） |
| 跨版本 | 能（小版本/大版本） | 只能同版本 |
| 适用 | 小库、迁移、单表恢复 | 生产库灾难恢复 |

**生产标配**：物理全备（每周）+ WAL 连续归档 + 逻辑备份（每日，用于单表恢复）。

### 逻辑备份

```bash
# 单库（自定义格式，支持并行恢复与选择性恢复）
pg_dump -Fc -Z6 -f /backup/db.dump -h 10.0.0.10 -U postgres mydb

# 全库（所有库 + 角色）
pg_dumpall -f /backup/all.sql

# 恢复
pg_restore -d mydb_new -j 4 /backup/db.dump        # 并行 4

# 只恢复某张表
pg_restore -d mydb -t orders /backup/db.dump
```

**注意**：`pg_dump` 是"一致性快照"（靠 MVCC），不需要停库，但**大库会跑很久**，且会占用 IO。

### 物理备份 + WAL 归档

**① 开启 WAL 归档** `postgresql.conf`：

```ini
wal_level = replica                 # 或 logical（需要逻辑复制时）
archive_mode = on
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'
# 生产建议用 pgBackRest / wal-g 而不是裸 cp
max_wal_senders = 5
```

`archive_command` 的要点：**返回 0 才算成功**，失败会重试（`test ! -f` 避免重复）。

**② 基础备份**

```bash
pg_basebackup -h 10.0.0.10 -U replicator \
  -D /backup/base -Ft -z -P -X stream
```

`-X stream` 表示把备份期间的 WAL 一起打包（否则要另外拷）。

**③ PITR 恢复**

```
① 停库
② 清空数据目录（或恢复到新目录）
③ 解压基础备份
④ 配置 recovery（PG 12+ 用 recovery.signal 文件）
⑤ 指定恢复目标时间
⑥ 启动，等待恢复完成
```

PG 12+ 的做法：

```bash
# 1. 清空
mv $PGDATA $PGDATA.old && mkdir $PGDATA && chown postgres:postgres $PGDATA

# 2. 解压基础备份
tar -xzf /backup/base.tar.gz -C $PGDATA
tar -xzf /backup/pg_wal.tar.gz -C $PGDATA/pg_wal

# 3. 恢复配置
cat > $PGDATA/postgresql.auto.conf <<'EOF'
restore_command = 'cp /archive/%f %p'
recovery_target_time = '2026-11-27 10:29:00+08'
recovery_target_action = 'promote'
EOF
touch $PGDATA/recovery.signal

# 4. 启动
pg_ctl -D $PGDATA start
# 观察日志："recovery stopping before ..." / "database system is ready to accept connections"
```

**关键：恢复到"删库前一秒"** —— 需要知道删除操作的确切时间点。这就是为什么**审计日志与操作记录**和备份同样重要。

### 三种典型的恢复场景

**① 误删表**

```
用逻辑备份恢复单表：
pg_restore -d mydb -t orders --data-only /backup/db.dump
（需要先建表或先 drop 现有表）
```

**② 误 UPDATE（改错数据）**

```
PITR 到 UPDATE 之前的时间点 → 导出该表 → 导回生产
不要直接在生产上 PITR（会丢失之后的所有写入）
```

**③ 磁盘损坏/整库丢失**

```
PITR 到最新（recovery_target_time 设为最后一个 WAL 的时间）
```

### 备份策略与 RPO/RTO

| 目标 | 策略 |
| --- | --- |
| RPO（最多丢多少数据） | WAL 连续归档 + 归档延迟 → 通常几分钟 |
| RTO（多久恢复） | 物理备份恢复时间 ≈ 数据量 / 磁盘带宽 + WAL 重放 |

示例：

```
数据 500G，恢复需要：
- 解压 10 分钟
- 启动 + WAL 重放 20 分钟
→ RTO 约 30 分钟
```

**RPO 最短取决于 `archive_command` 的执行频率**（每条 WAL 16MB，写完就归档）。高写入场景 RPO 可达秒级。

### 备份必须验证

**没验证过的备份不算备份**。

```bash
#!/usr/bin/env bash
# 每周自动验证：恢复到临时实例并查一行数据
set -euo pipefail
TMP=/tmp/pgverify && rm -rf $TMP && mkdir -p $TMP
pg_basebackup -h 10.0.0.10 -U replicator -D $TMP/data -Ft -z -X stream
tar -xzf $TMP/data/base.tar.gz -C $TMP/data
echo "restore_command='cp /archive/%f %p'" >> $TMP/data/postgresql.auto.conf
touch $TMP/data/recovery.signal
pg_ctl -D $TMP/data -o "-p 55432" start
sleep 30
psql -p 55432 -c 'SELECT count(*) FROM public.orders;'
pg_ctl -D $TMP/data stop
echo "verify OK"
```

放到 cron 每周跑，失败就告警。

### 工具推荐

| 工具 | 特点 |
| --- | --- |
| pgBackRest | 增量、并行、压缩、校验，最成熟 |
| wal-g | 云存储友好（S3/OSS） |
| Barman | 多实例集中管理 |

```bash
# pgBackRest 示例
pgbackrest --stanza=main backup --type=full
pgbackrest --stanza=main check
pgbackrest --stanza=main restore --target-time="2026-11-27 10:29:00+08"
```

### 检查清单

```
□ 每日逻辑备份 + 每周物理全备
□ WAL 连续归档（archive_mode=on）
□ 归档目录与数据目录不在同一磁盘
□ 备份异地/对象存储保留一份
□ 每周自动验证恢复（真的起一个实例查数据）
□ 重要操作有审计日志（PITR 需要时间点）
□ 知道自己的 RPO/RTO 是多少
```
