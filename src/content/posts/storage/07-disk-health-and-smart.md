---
title: 磁盘故障预警：SMART 告诉你硬盘还剩几天
description: SMART 里哪几个属性真正有用、RAID 卡与 SSD 的特殊情况、怎么批量巡检、以及"Pending Sector"出现后该做什么。
date: 2023-06-26
tags: [存储, 磁盘, SMART, 运维]
---

### 只看一个指标：Pending Sector

`smartctl -a` 输出几十项，但真正决定"该换了"的只有几个：

| ID | 属性 | 含义 | 危险信号 |
| --- | --- | --- | --- |
| 5 | Reallocated_Sector_Ct | 已重映射扇区 | **> 0 就要关注** |
| 187 | Reported_Uncorrect | 无法纠正的错误 | **> 0 立即换** |
| 197 | Current_Pending_Sector | 待映射扇区 | **> 0 说明读不出来** |
| 198 | Offline_Uncorrectable | 离线不可纠正 | **> 0 立即换** |
| 9 | Power_On_Hours | 通电时长 | 参考寿命 |
| 194 | Temperature | 温度 | HDD > 50℃ 偏高 |

**判读顺序**：

```
197 / 198 > 0  → 数据已经读不出来，立即备份并更换
187 > 0        → 介质错误，换
5 持续增长      → 盘在退化，计划更换（1–2 周内）
```

其他属性（如 `Raw_Read_Error_Rate`）在不同厂商含义不同，**不要当通用指标**。

### 单盘检查

```bash
# 基础信息 + 健康状态
smartctl -H /dev/sda
# 全部属性
smartctl -a /dev/sda
# 短自检（2 分钟）与长自检（数小时）
smartctl -t short /dev/sda
smartctl -t long /dev/sda
smartctl -l selftest /dev/sda
```

关键输出：

```
SMART overall-health self-assessment test result: PASSED
197 Current_Pending_Sector  0x0032   100   100   000    Old_age   Always  -  0
```

### RAID 卡后面的盘

RAID 卡会把盘"藏起来"，`smartctl -a /dev/sda` 看到的是虚拟盘。

```bash
# 通过 RAID 卡透传（LSI/MegaRAID）
smartctl -a -d megaraid,0 /dev/sda     # 第 0 块物理盘
smartctl -a -d megaraid,1 /dev/sda

# 先看有几块
storcli /c0 /eall /sall show
```

**SAS 盘**用 `-d sat` 或 `-d scsi`：

```bash
smartctl -a -d sat /dev/sdb
```

### SSD 的特殊项

| 项 | 含义 |
| --- | --- |
| `Percentage Used`（NVMe） | 寿命消耗，100% 表示到设计寿命 |
| `Media and Data Integrity Errors` | 数据完整性错误，> 0 要换 |
| `Available Spare` | 备用块剩余，低于阈值报警 |
| `Wear_Leveling_Count` | 磨损均衡次数 |

```bash
nvme smart-log /dev/nvme0
# percentage_used : 3%
# media_errors : 0
```

**NVMe 的 `media_errors` 一旦 > 0，就该换盘**——它表示已经发生过无法纠正的数据错误。

### 批量巡检

```bash
#!/usr/bin/env bash
# 巡检所有盘，输出可疑项
for d in /dev/sd? /dev/nvme?n1; do
  [ -b "$d" ] || continue
  echo "=== $d"
  smartctl -H "$d" 2>/dev/null | grep -E 'result'
  smartctl -A "$d" 2>/dev/null | awk '
    $1==5 || $1==187 || $1==197 || $1==198 {
      if ($10+0 > 0) printf "  ALERT attr=%s raw=%s\n", $1, $10
    }'
done
```

挂到 cron 每天跑一次，有 ALERT 就发告警。

### Pending Sector 出现后

处理顺序：

```
① 立即确认 RAID/副本状态（是否还有冗余）
② 备份该盘上的数据（不要先做修复）
③ 尝试"触发重映射"：全盘读一遍，让盘把坏块换掉
   dd if=/dev/sda of=/dev/null bs=1M conv=noerror,sync
④ 复检 197 是否下降
⑤ 仍存在 → 更换
```

**不要对出问题的盘做 `fsck -y` 或在线修复**，那可能加速损坏。

### 温度与振动

```
HDD 长期 > 50℃：寿命明显缩短
SSD 长期 > 70℃：可能降速（NVMe 会 thermal throttle）
机箱振动：机械盘的隐形杀手（共振会导致重映射增加）
```

```bash
# 温度
smartctl -A /dev/sda | grep -i temp
# NVMe 温度
nvme smart-log /dev/nvme0 | grep temperature
```

### 寿命预测

```
HDD：
- Power_On_Hours 超过 5 年（约 4.4 万小时）→ 进入高故障期
- 重映射扇区 3 个月内增长 > 10 → 快速退化

SSD：
- Percentage Used 超过 80% → 计划更换
- 写入量（Data Units Written）接近 TBW 标称值
```

**真实经验**：机械盘故障曲线是"浴盆形"——前 1 年和 5 年后故障率高，中间稳定。所以"服役 5 年以上的盘"要主动替换，别等坏。

### 监控接入

```yaml
# textfile collector
# /var/lib/node_exporter/textfile/disk_health.prom
smartmon_health{disk="sda"} 1
smartmon_pending_sectors{disk="sda"} 0
smartmon_reallocated{disk="sda"} 0
```

告警规则：

```yaml
- alert: DiskPendingSector
  expr: smartmon_pending_sectors > 0
  for: 1h
  labels: { severity: warning }
  annotations: { summary: "磁盘 {{ $labels.disk }} 出现待映射扇区" }

- alert: DiskHealthFail
  expr: smartmon_health != 1
  labels: { severity: critical }
```

### 检查清单

```
□ 所有盘都纳入 SMART 巡检（含 RAID 后面的物理盘）
□ 关注 5/187/197/198 四项
□ NVMe 看 media_errors 与 percentage_used
□ 有每日巡检脚本 + 告警
□ 出问题的盘先备份再处理
□ 服役 5 年以上的盘有计划替换
```
