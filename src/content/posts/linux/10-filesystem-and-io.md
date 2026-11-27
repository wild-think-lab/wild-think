---
title: 文件系统与 IO 调度：ext4、XFS、Btrfs 怎么选
description: 四种文件系统的差异、IO 调度器的适配、挂载参数的性能与安全取舍、以及"删了文件空间不释放"的 FS 侧原因。
date: 2026-11-27
tags: [Linux, 文件系统, IO, 存储]
---

### 三种主流文件系统的定位

| | ext4 | XFS | Btrfs |
| --- | --- | --- | --- |
| 定位 | 通用、稳 | 大文件、高并发 | 快照、校验、灵活卷 |
| 最大文件 | 16TB | 8EB | 16EB |
| 在线扩容 | 支持 | 支持 | 支持 |
| 在线缩容 | 支持 | **不支持** | 支持 |
| 快照 | 无 | 无（靠 LVM/存储） | 原生 |
| 数据校验 | 元数据 | 元数据 | 数据 + 元数据 |
| 适合 | 通用服务器、小文件多 | 数据库、大文件、日志 | 需要快照/校验的场景 |

判断：

- **数据库（MySQL/PG）** → XFS（并发写更好，删除/预分配行为更合适）。
- **通用 Web/文件服务器** → ext4（稳、工具链成熟）。
- **需要快照/回滚（容器、桌面、备份）** → Btrfs 或 ZFS。

**XFS 不能缩容**是最容易踩的坑：分区给太大之后想缩小，只能备份 + 重建。

### IO 调度器

```bash
cat /sys/block/sda/queue/scheduler
# [mq-deadline] kyber bfq none
```

| 调度器 | 适用 |
| --- | --- |
| `none`（noop） | SSD/NVMe，或上层已有队列（如 RAID 卡） |
| `mq-deadline` | 通用，保证延迟上限 |
| `bfq` | 桌面/低延迟交互 |
| `kyber` | 低延迟 NVMe |

```bash
# 临时切换
echo none > /sys/block/nvme0n1/queue/scheduler
# 永久（udev 规则）
echo 'ACTION=="add|change", KERNEL=="nvme*", ATTR{queue/scheduler}="none"' \
  > /etc/udev/rules.d/60-io-scheduler.rules
```

原则：**NVMe 用 none，机械盘用 mq-deadline，虚拟机看上层**。

### 挂载参数

```fstab
# ext4 数据库
/dev/sdb1 /data ext4 defaults,noatime,nodiratime,data=ordered 0 2

# XFS 大文件
/dev/sdc1 /logs xfs defaults,noatime,largeio,inode64 0 0
```

关键参数：

| 参数 | 作用 | 风险 |
| --- | --- | --- |
| `noatime` | 不记录访问时间，减少写 | 少数依赖 atime 的工具受影响 |
| `data=writeback` | ext4 数据不回写顺序 | 崩溃可能丢数据，慎用 |
| `barrier=0` | 关闭写屏障 | **掉电可能损坏**，只在有 UPS + 电池缓存时用 |
| `discard` | 实时 TRIM | 部分 SSD 上会造成延迟抖动 |
| `nofail` | 挂载失败不阻止启动 | 需要自己监控是否真挂上 |

`nofail` 很重要：**没有它的 fstab 里一个坏的 NFS/磁盘，会让机器起不来**。

### TRIM 的正确姿势

```bash
# 推荐：定期 fstrim，而不是实时 discard
systemctl enable --now fstrim.timer
fstrim -av
```

实时 `discard` 的问题：删除大文件时会产生大量 TRIM 命令，造成 IO 抖动。

### "删了文件空间不释放"的三种 FS 侧原因

1. **进程持有已删除文件的 fd**（最常见，与 FS 无关）。
2. **ext4 的延迟分配**：数据还在 journal/页缓存里，`sync` 后才释放。
3. **Btrfs/ZFS 的快照**：快照还引用着旧数据块。

```bash
# ① 查持有者
lsof +L1
# ② 强制落盘
sync
# ③ Btrfs 查快照
btrfs subvolume list /
btrfs filesystem usage /
```

### 扩容与缩容

**ext4**：

```bash
# 扩容（先扩分区再扩 FS）
growpart /dev/sda 2
resize2fs /dev/sda2

# 缩容（必须先 umount）
umount /data
e2fsck -f /dev/sda2
resize2fs /dev/sda2 50G
```

**XFS**：

```bash
xfs_growfs /data          # 只能扩，不能缩
```

**LVM 上的通用做法**：

```bash
lvextend -L +20G /dev/vg0/data
xfs_growfs /data            # 或 resize2fs
```

### 文件系统损坏的处理

```bash
# 先看是不是真的坏了
dmesg | grep -i 'ext4\|xfs\|I/O error'

# ext4 修复（必须卸载）
umount /data
fsck -y /dev/sda2

# XFS 修复
xfs_repair /dev/sdc1
```

**修复前必须备份**：`fsck` 与 `xfs_repair` 都可能"修"掉数据。

### 监控指标

```bash
# 文件系统使用率（含 inode）
df -h; df -i
# IO 延迟与队列
iostat -x 1 5
# 挂载是否还在（NFS 常用）
mountpoint -q /mnt/nfs || echo "NFS not mounted"
```

关键阈值：

| 指标 | 告警线 |
| --- | --- |
| 空间使用率 | 85% |
| inode 使用率 | 80% |
| `await` | > 50ms（机械）/ > 10ms（SSD） |
| `%util` | 持续 > 90% |

### 选型速记

```
数据库 → XFS
通用服务器/小文件 → ext4
要快照/校验/容器存储 → Btrfs 或 ZFS
超大规模/分布式 → Ceph（底层仍是 XFS/ext4）
```
