---
title: LVM 与 ZFS：两块盘的容量魔术与数据保险
description: LVM 的 PV/VG/LV 三层与在线扩容、快照的正确用法、ZFS 的 pool/dataset 与校验、raidz 级别选择、scrub 与替换盘流程，附选型建议。
date: 2022-09-16
tags: [LVM, ZFS, 存储, 运维]
---

### LVM 解决什么问题

一句话：**把物理盘的容量切成可以自由拼装、随时调整的逻辑块**。

三层结构：

```
物理卷 PV（/dev/sdb1、/dev/sdc）
   ↓
卷组 VG（把多个 PV 拼成一个池）
   ↓
逻辑卷 LV（从池里切出的块，格式化成文件系统挂载）
```

好处：

- 容量可在线扩（加盘 → 加进 VG → 扩 LV → 扩文件系统）。
- 一个文件系统能跨多块盘。
- 能做快照（copy-on-write）。

### 从零建一套

```bash
# 1. 建 PV
pvcreate /dev/sdb /dev/sdc
pvs

# 2. 建 VG（名字 data）
vgcreate data /dev/sdb /dev/sdc
vgs

# 3. 建 LV（用掉 90% 空间，留余量）
lvcreate -l 90%FREE -n app data
lvs

# 4. 格式化并挂载
mkfs.xfs /dev/data/app
mkdir -p /data/app
mount /dev/data/app /data/app

# 5. 写进 fstab（用 UUID 更稳）
blkid /dev/data/app
echo 'UUID=xxxx /data/app xfs defaults 0 0' >> /etc/fstab
```

### 在线扩容：加一块盘，不停机

```bash
# 加入新盘
pvcreate /dev/sdd
vgextend data /dev/sdd

# 扩 LV（+50G 或全部剩余）
lvextend -L +50G /dev/data/app
# 或
lvextend -l +100%FREE /dev/data/app

# 扩文件系统
xfs_growfs /data/app            # XFS
resize2fs /dev/data/app         # ext4
```

XFS 只能扩不能缩；ext4 可以缩但要先卸载。**要缩容就用 ext4，或者干脆新建一个 LV 迁数据。**

### 快照：应急可以，别当备份

```bash
lvcreate -L 10G -s -n app_snap /dev/data/app
mkdir -p /mnt/snap && mount /dev/data/app_snap /mnt/snap
# 用完
umount /mnt/snap && lvremove /dev/data/app_snap
```

关键限制：

- 快照空间只存"变化块"。**写入量超过快照大小，快照会失效**（`lvs` 里 `Data%` 到 100% 就废了）。
- 快照在同一条盘上，盘坏了快照一起没。
- 所以快照适合"升级前 30 分钟的后悔药"，不适合"三个月前的数据恢复"。

### ZFS：另一种思路

ZFS 把"卷管理 + 文件系统 + 校验 + 快照"合成一体，核心是 **CoW（写时复制）** 与 **端到端校验和**。

```bash
# 建池（raidz1 = 类似 RAID5，允许坏 1 块盘）
zpool create -o ashift=12 tank raidz1 /dev/sdb /dev/sdc /dev/sdd

# 建数据集（相当于文件系统）
zfs create tank/app
zfs set compression=lz4 tank/app
zfs set atime=off tank/app
zfs set quota=200G tank/app      # 可选：限制用量

# 挂载点自动是 /tank/app
zfs list
zpool status
```

`ashift=12` 对齐 4K 扇区，SSD 上必加，否则写入放大严重。

### raidz 级别怎么选

| 级别 | 容错 | 容量利用率 | 适合 |
| --- | --- | --- | --- |
| mirror（镜像） | 1 块 | 50% | 数据库、虚拟机盘（IOPS 高） |
| raidz1 | 1 块 | (n-1)/n | 备份、归档（大文件顺序读写） |
| raidz2 | 2 块 | (n-2)/n | 大容量、重建风险高的盘 |
| raidz3 | 3 块 | (n-3)/n | 极重要冷数据 |

经验：**盘越大，越该用 raidz2**。8TB 以上的盘重建要几十小时，期间再坏一块就全没了。

### 校验：ZFS 的最大价值

```bash
zpool scrub tank              # 全量校验，会读一遍所有数据并修复
zpool status tank             # 看 scrub 结果与错误计数
zpool status -v               # 列出损坏文件的具体路径
```

定期 scrub（比如每月一次）能把"静默损坏"提前暴露出来。这是 ext4/LVM 做不到的。

### 换盘流程（ZFS）

```bash
# 1. 确认故障盘
zpool status -v

# 2. 物理更换后，替换
zpool replace tank /dev/sdb /dev/sde

# 3. 观察重建进度
zpool status tank
```

重建期间性能会明显下降，**别在业务高峰做**。`raidz1` 重建时如果又坏一块，池就废了。

### LVM 与 ZFS 怎么选

| 场景 | 推荐 | 理由 |
| --- | --- | --- |
| 单机应用盘、要在线扩 | LVM + XFS | 简单、成熟、扩容顺手 |
| 数据库/虚拟机存储 | ZFS mirror 或 LVM + SSD | 需要 IOPS 与快照 |
| 备份/归档大盘 | ZFS raidz2 | 校验、压缩、快照 |
| 已有硬件 RAID 卡 | 硬件 RAID + LVM | 双保险，但别叠 ZFS |
| 容器/云盘 | 直接云盘或 Ceph | 单机存储不是重点 |

**不要叠三层**：硬件 RAID 上再建 ZFS，或者 ZFS 上面再建 LVM，都是给自己找麻烦。

### 常见坑

1. **LV 扩了但文件系统没扩**：`df` 看还是旧容量。别忘了 `xfs_growfs`。
2. **fstab 用 `/dev/data/app`**：盘序变化会挂错。用 UUID 或 `/dev/mapper/` 路径。
3. **快照占满**：`lvs` 的 `Data%` 要监控，超过 80% 就扩或删。
4. **ZFS 内存**：默认 ARC 会用掉一半内存。数据库机要限制：`zfs set` 不行，得改 `/etc/modprobe.d/zfs.conf` 的 `zfs_arc_max`。
5. **ZFS 上跑数据库**：`recordsize` 默认 128K，数据库建议设 8K–16K。

```bash
echo 'options zfs zfs_arc_max=8589934592' > /etc/modprobe.d/zfs.conf   # 8G
update-initramfs -u
```

### 一句话总结

**LVM 解决"容量灵活"，ZFS 解决"数据可信"**。前者是运维手感，后者是数据保险，两者解决的不是同一件事。
