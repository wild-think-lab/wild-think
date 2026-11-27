---
title: 备份与恢复演练：备份只有恢复到能跑才算数
module: 熟练篇
summary: 逻辑/物理备份的取舍、PITR 全流程、恢复演练清单，以及五个"备份了但恢复不了"的原因。
minutes: 50
---

### 两种备份

```
逻辑（mysqldump）：可读、可选择性恢复、慢
物理（xtrabackup）：快、适合大库、要一致性快照
```

**判据**：

```
< 10G → 逻辑备份够用
> 50G → 物理备份 + binlog
```

### 逻辑备份

```bash
mysqldump -u root -p --single-transaction --quick \
  --routines --triggers --events --set-gtid-purged=ON \
  -B app > app_$(date +%F).sql
```

**要点**：

```
① --single-transaction（InnoDB 一致性，不锁表）
② --routines/--triggers（别丢存储过程）
③ --set-gtid-purged（GTID 环境必须想清楚）
```

### 物理备份

```bash
xtrabackup --backup --target-dir=/backup/full --user=root --password=xxx
xtrabackup --prepare --target-dir=/backup/full
```

**恢复**：

```bash
systemctl stop mysqld
rm -rf /var/lib/mysql/*
xtrabackup --copy-back --target-dir=/backup/full
chown -R mysql:mysql /var/lib/mysql
systemctl start mysqld
```

### PITR（时间点恢复）

```
① 恢复最近一次全备
② 用 binlog 重放到"故障前一秒"
```

```bash
mysqlbinlog --start-datetime="2026-11-27 09:00:00" \
            --stop-datetime="2026-11-27 10:05:00" \
  mysql-bin.000123 | mysql -u root -p app
```

**关键**：知道"误操作的具体时间"（最好在操作前有审计/变更记录）。

### 备份也要"校验"

```bash
# 逻辑备份：试着导入到临时库
mysql -u root -e "CREATE DATABASE verify"
mysql -u root verify < app_2026-11-27.sql

# 物理备份：xtrabackup --prepare 成功本身就是校验
```

**"备份文件存在"** ≠ "能恢复"。

### 五个"备份了但恢复不了"

**① 没备份 binlog**

```
无法 PITR（只能恢复到全备时刻）
```

**② 备份在同一个盘/同一台机器**

```
机器挂了备份也没了
```

**③ 备份账号权限不够**

```
恢复时发现缺少 DEFINER 或权限
```

**④ 忘了存储过程/触发器/事件**

```
mysqldump 参数没带 → 恢复后功能缺失
```

**⑤ 没演练**

```
恢复步骤里少一步（改属主），启动失败
```

### 恢复演练清单（每季度）

```
1) 在隔离环境准备一台空实例
2) 取"昨天的备份"
3) 全量恢复 → 起库 → 连接验证
4) PITR 到"昨天 23:59" → 校验关键表数据
5) 记录耗时（这就是 RTO）
6) 更新 runbook
```

**"演练只做一次"** 不够；流程会随环境变化。

### 3-2-1 原则

```
3 份副本
2 种介质（本地盘 + 对象存储/磁带）
1 份异地
```

**防勒索**：至少一份"离线/不可写"的副本。

### 检查清单

```
□ 有 RPO/RTO 指标
□ 备份类型与库大小匹配
□ binlog 保留时间 ≥ 备份周期 × 2
□ 备份异地/离线一份
□ 备份有校验（导入或 prepare）
□ 备份失败有告警
□ 有恢复 runbook
□ 每季度恢复演练
□ 演练记录含耗时
□ 备份账号权限正确
```
