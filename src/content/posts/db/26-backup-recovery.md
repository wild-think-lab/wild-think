---
title: 备份与恢复：没演练过的备份等于没有备份
description: 备份的三层目标（RPO/RTO）、全量增量差异、MySQL/PG/文件/容器四类做法，以及五个"以为有备份"的幻觉。
date: 2026-11-27
tags: [备份, 容灾, 运维]
---

### 先定两个指标

```
RPO（Recovery Point Objective）：能容忍丢多久的数据
RTO（Recovery Time Objective） ：能容忍多久恢复服务
```

**这两个数字决定"做多贵的备份"**：

```
RPO = 0           → 需要同步复制（成本高）
RPO = 1 小时      → 每小时备份/增量
RPO = 1 天        → 每天全量即可
RTO = 5 分钟      → 热备/双活
RTO = 4 小时      → 冷备 + 恢复脚本
```

**"没有 RPO/RTO 的备份方案"无法验证是否够用**。

### 三层结构

```
① 本地快照/备份：快速回滚（分钟级）
② 同城异地：机房间复制（小时级）
③ 离线冷备：定期导出，物理隔离（防勒索）
```

**"3-2-1" 原则**：

```
3 份数据、2 种介质、1 份异地
（再加一条：至少演练过一次恢复）
```

### MySQL 的三种备份

**① 逻辑备份（mysqldump）**

```bash
mysqldump --single-transaction --master-data=2 \
  --routines --triggers --events -A > all.sql
```

**优点**：可读、可选择性恢复。
**缺点**：大库慢（几小时）、恢复也慢。

**`--single-transaction`** 保证 InnoDB 一致性（不加全局锁）。

**② 物理备份（XtraBackup）**

```bash
xtrabackup --backup --target-dir=/backup/full
xtrabackup --prepare --target-dir=/backup/full
xtrabackup --copy-back --target-dir=/backup/full
```

**优点**：快、支持增量。
**缺点**：需要版本匹配、恢复要 prepare。

**③ 从库 + binlog**

```
从库持续同步（准实时副本）
binlog 保留（可做时间点恢复）
```

**这是生产最常用的组合**：

```
全量（每天）+ binlog（持续）→ 能恢复到"任意时刻"
```

**时间点恢复（PITR）**：

```bash
# 恢复全量后，重放 binlog 到故障前一刻
mysqlbinlog --stop-datetime="2026-11-27 10:29:00" binlog.000001 | mysql
```

**"误删表"只有 binlog 能救**。

### PostgreSQL 的备份

```bash
# 逻辑
pg_dump -Fc mydb > mydb.dump
pg_restore -d mydb mydb.dump

# 物理（基础备份 + WAL 归档）
pg_basebackup -D /backup/base -Ft -z -P
# 配合 archive_mode=on + archive_command 归档 WAL → PITR
```

**PITR**：

```conf
restore_command = 'cp /archive/%f %p'
recovery_target_time = '2026-11-27 10:29:00'
```

### 文件备份

```bash
# rsync 增量（注意删除行为）
rsync -av --delete /data/ /backup/data/

# tar 归档
tar --zstd -cf /backup/data-$(date +%F).tar.zst /data

# 快照（LVM/ZFS/btrfs）
lvcreate -L 10G -s -n snap /dev/vg/data
```

**`--delete` 是双刃剑**：

```
源端误删 → 备份也删（"镜像"不是"备份"）
→ 重要数据要保留多版本（不要只留最新一份）
```

**"rsync --delete 把备份一起删掉"是经典事故**。

### 容器与 K8s 的备份

```
① 无状态服务：不用备份（镜像+配置即可重建）
② 有状态数据：备份"卷里的数据"（不是备份 Pod）
③ etcd：集群状态的核心（必须单独备份）
```

**etcd 备份**：

```bash
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

etcdctl snapshot status /backup/etcd-xxx.db
```

**"没备份 etcd"意味着"集群丢了就重建"**。

### 五个"以为有备份"的幻觉

**① 有快照 = 有备份**

```
快照依赖原卷，原卷损坏 → 一起丢
```

**② 有 RAID = 有备份**

```
RAID 防"盘坏"，不防"误删/勒索/控制器故障"
```

**③ 备份在同一机房**

```
机房进水/断电/火灾 → 一起没
```

**④ 备份任务"成功"但文件是空的**

```
脚本 exit 0 但实际没写数据（磁盘满、权限错）
→ 必须校验"备份文件大小/可恢复性"
```

**⑤ 从没恢复过**

```
备份格式对但恢复流程不熟 → 出事时手忙脚乱
```

**"恢复演练"是备份体系的唯一验收标准**。

### 备份监控要看什么

```
① 任务是否按时执行（不是"上次成功"就算）
② 备份文件大小趋势（突然变小 = 异常）
③ 校验和/可读性（定期抽样恢复）
④ 存储剩余空间（备份也会撑爆磁盘）
⑤ 保留策略是否生效（旧备份是否被清理）
```

**"大小趋势"是最实用的信号**。

### 一个"能落地"的备份方案

```
数据库：每天全量（XtraBackup）+ binlog 实时归档（异地）
文件：每天增量 rsync 到备份机 + 每周全量到对象存储
配置/代码：Git（天然版本）
etcd：每天快照 + 保留 7 天
保留：本地 7 天、异地 30 天、冷备 6 个月
演练：每季度一次"从备份恢复一套环境"
```

**"演练排进日历"** 否则永远不会做。

### 检查清单

```
□ 有 RPO/RTO 目标
□ 3-2-1（3 份/2 介质/1 异地）
□ 数据库：全量 + binlog/WAL（支持 PITR）
□ 文件备份保留多版本（不只最新）
□ etcd 单独备份
□ 备份任务有监控（执行/大小/空间）
□ 定期抽样验证可恢复
□ 每季度恢复演练
□ 备份存储与生产隔离（防勒索）
□ 保留策略生效（旧备份会清理）
□ 演练有记录（谁、多久、是否达标）
```
