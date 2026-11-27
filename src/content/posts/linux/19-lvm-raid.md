---
title: LVM 与 RAID：盘坏了、满了、要扩的时候怎么办
description: 扩容三步法、软 RAID 三种级别的取舍、盘故障替换流程，以及五个"扩容失败"的原因。
date: 2025-03-30
tags: [Linux, 存储, LVM]
---

### LVM 三层结构

```
PV（物理卷） → VG（卷组，把多块盘合池） → LV（逻辑卷，可扩可缩）
```

```bash
pvs / vgs / lvs
```

**"能在线扩容"是 LVM 最大的价值**。

### 扩容三步法（最常见操作）

```bash
# 1) 新盘加入 VG
pvcreate /dev/sdb
vgextend vg0 /dev/sdb

# 2) 扩 LV
lvextend -l +100%FREE /dev/vg0/lvdata

# 3) 扩文件系统（关键，别忘）
xfs_growfs /data            # XFS
resize2fs /dev/vg0/lvdata   # ext4
```

**"扩了 LV 但 `df` 没变"** = 忘了第 3 步。

### 缩容（ext4 才行）

```bash
umount /data
e2fsck -f /dev/vg0/lvdata
resize2fs /dev/vg0/lvdata 200G
lvreduce -L 200G /dev/vg0/lvdata
mount /data
```

**XFS 不支持缩容**（只能扩）。

**"缩容顺序错了会丢数据"**：

```
必须先缩文件系统，再缩 LV
（反过来 = 文件系统越过 LV 边界 → 数据损坏）
```

### RAID 级别取舍

| 级别 | 最少盘 | 容错 | 可用容量 | 场景 |
| --- | --- | --- | --- | --- |
| RAID0 | 2 | 0 | 100% | 临时/测试（不推荐生产） |
| RAID1 | 2 | 1 块 | 50% | 系统盘/小容量关键数据 |
| RAID5 | 3 | 1 块 | (n-1)/n | 读多写少的归档 |
| RAID6 | 4 | 2 块 | (n-2)/n | 大容量归档 |
| RAID10 | 4 | 每组 1 块 | 50% | 数据库（推荐） |

**关键**：

```
RAID5 的"写惩罚" = 4 次 IO/写 → 写密集场景极差
大容量盘（>4TB）重建时间长 → RAID5 期间第二块盘坏 = 全丢
→ 生产优先 RAID10；大容量归档用 RAID6
```

### 软 RAID（mdadm）

```bash
mdadm --create /dev/md0 --level=10 --raid-devices=4 /dev/sd[b-e]
cat /proc/mdstat
mdadm --detail /dev/md0
```

**故障替换**：

```bash
# 标记故障
mdadm /dev/md0 --fail /dev/sdc1 --remove /dev/sdc1
# 换盘后加入
mdadm /dev/md0 --add /dev/sdc1
# 查看重建进度
cat /proc/mdstat
```

**"重建期间性能下降明显"** 是正常的（可以调 `sync_speed_max`）。

### 五个"扩容失败"的原因

**① 忘了扩文件系统**

```
df 不变 → 最常见（占 80%）
```

**② VG 没有空闲空间**

```
vgs 看 VFree=0 → 需要先 pvcreate + vgextend
```

**③ 扩的是分区不是 LV**

```
/dev/sdb1 扩了，但 LV 还在老分区上
→ 用 parted 扩分区后要 pvresize
```

```bash
parted /dev/sdb resizepart 1 100%
pvresize /dev/sdb1
```

**④ 云盘扩容后操作系统没感知**

```
云厂商扩了盘 → 系统内还是老大小
→ 需要 rescan：echo 1 > /sys/class/block/sdb/device/rescan
```

**⑤ LVM metadata 损坏**

```
pvs 报 "Couldn't find device with uuid"
→ 用 vgcfgrestore 恢复元数据（先备份 /etc/lvm/backup）
```

### 一个"安全检查"套路

```bash
# 扩之前
df -h /data; lvs; vgs; pvs
# 扩之后
lvs; df -h /data
# RAID 健康
cat /proc/mdstat
mdadm --detail /dev/md0 | grep -E "State|Active"
```

**"每次操作前后都记录一次"** —— 出问题时能对比。

### 检查清单

```
□ 扩容必做"扩文件系统"
□ XFS 不做缩容（ext4 才可）
□ 缩容顺序：fs → LV
□ 生产用 RAID10（数据库），归档用 RAID6
□ 不用 RAID5 存写密集数据
□ RAID 重建期间有性能预期
□ 盘替换流程演练过
□ VG 预留 10% 空间（便于应急）
□ /etc/lvm/backup 定期备份
□ 有 RAID/LVM 状态监控告警
```
