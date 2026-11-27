---
title: Proxmox VE 的备份与恢复： vzdump、PBS 与"真的能还原吗"
description: 三种备份方式（ vzdump 快照/停止/挂起）、备份保留策略、Proxmox Backup Server 的增量去重、恢复单文件与整机的差别，以及恢复演练清单。
date: 2026-11-27
tags: [Proxmox, 备份, 虚拟化, 恢复]
---

### 备份的三条铁律

1. **没恢复过的备份不算备份**。
2. **备份要和原机分开存放**（另一台机器、另一个机房）。
3. **保留至少三代**（今天坏的数据，可能要回到上周）。

### vzdump 的三种模式

```bash
# 快照模式（运行中备份，不中断）
vzdump 101 --mode snapshot --storage backup --compress zstd

# 挂起模式（短暂冻结，一致性最好）
vzdump 101 --mode suspend --storage backup

# 停止模式（关机备份，最一致但会中断业务）
vzdump 101 --mode stop --storage backup
```

| 模式 | 业务中断 | 一致性 | 适用 |
| --- | --- | --- | --- |
| snapshot | 无 | 较好（依赖 qemu 快照） | 生产首选 |
| suspend | 几秒 | 好 | 对一致性要求高 |
| stop | 全程 | 最好 | 停机窗口内 |

**snapshot 模式并不保证应用层一致**：数据库还在写，文件系统快照可能是"崩溃一致"状态。要在应用层做一致性，得配合 `qm guest cmd` 触发 fsync，或者干脆用数据库自己的备份工具。

### 定时备份与保留

Web UI：`数据中心 → 备份 → 添加`。命令行等价：

```bash
# 每周日 2:00 备份所有 VM，保留 4 份
pvesh create /cluster/backup --vmid 100-199 \
  --schedule 'sun 02:00' --storage backup --mode snapshot \
  --compress zstd --prune-backups keep-last=4
```

`keep-last` 之外还有更细的策略：

```
keep-daily=7,keep-weekly=4,keep-monthly=3
```

第 4 项最实用：`keep-daily=7` 保证本周内任意一天可回，`keep-weekly=4` 保证一个月，`keep-monthly=3` 保证一季度。

### 备份文件长什么样

```
/dump/vzdump-qemu-101-2026_11_27-02_00_03.vma.zst
/dump/vzdump-lxc-102-2026_11_27-02_00_03.tar.zst
```

- VM 用 **VMA** 格式（包含磁盘、配置、快照信息）。
- LXC 用 **tar**（本质是文件打包，可以手工解出来看）。

看内容：

```bash
# 列出 VMA 里的磁盘
vma list /dump/vzdump-qemu-101-2026_11_27-02_00_03.vma.zst
```

### 恢复的三种粒度

**① 整机恢复（覆盖）**

```bash
qmrestore /dump/vzdump-qemu-101-2026_11_27-02_00_03.vma.zst 101 --storage local-lvm
```

**② 恢复成新 VM（不覆盖原机）**

```bash
qmrestore vma.zst 199 --storage local-lvm
# 199 是新的 VMID，起一台新机做验证
```

这是**恢复演练的正确姿势**：不覆盖生产，起一台新的验证完再决定。

**③ 单文件恢复（最常用的救急）**

VMA 不能直接挂载，做法是起一台临时 VM 或把磁盘映射出来：

```bash
# 把备份里的磁盘映射成临时块设备（不启动）
qm importdisk 199 vma.zst local-lvm     # 或先恢复再挂载
# 更简单的路径：恢复整机到临时 VMID，挂载后拷文件
qmrestore vma.zst 199 --storage local-lvm
qm start 199
# 从临时 VM 里 scp 出需要的文件
```

LXC 更简单，直接解 tar：

```bash
mkdir /tmp/restore && tar xf vzdump-lxc-102-*.tar.zst -C /tmp/restore
ls /tmp/restore/var/lib/mysql      # 直接看到文件
```

### Proxmox Backup Server（PBS）

PBS 是独立产品，相比 vzdump 到目录的优势：

| | vzdump（目录/NFS） | PBS |
| --- | --- | --- |
| 增量 | 每次都全量 | 块级增量 |
| 去重 | 无 | 全局去重 |
| 加密 | 可选（zstd 压缩） | 客户端加密 |
| 校验 | 无 | 定期 verify |
| 恢复速度 | 中 | 快（可直接从备份启动） |

配置：

```bash
# PVE 上添加 PBS 存储
pvesh create /storage --storage pbs01 --type pbs \
  --server 192.168.1.40 --datastore backup \
  --username backup@pbs --password '***' --fingerprint xx:xx

# 备份到 PBS
vzdump 101 --storage pbs01 --mode snapshot
```

PBS 的 `verify` 是关键：它会重算备份的校验和，发现损坏。

```bash
proxmox-backup-manager verify backup --backup-id vm/101
```

### 别忘了这些

- **备份目录的容量**：备份和虚拟机放在同一块盘上，盘坏了全没。至少放另一台机器。
- **备份窗口**：几十台 VM 同时 backup 会把存储 IO 打满。用 `--bwlimit` 限速，或用 `pigz` 多线程。
- **配置也要备份**：`/etc/pve` 是集群配置（PMXCFS），不在 VM 备份里：

```bash
tar czf /backup/pve-etc-$(date +%F).tar.gz /etc/pve /etc/network/interfaces /etc/hosts
```

- **加密**：备份文件里有全部数据，放到共享存储要加密（PBS 客户端加密或 LUKS 目录）。

### 恢复演练清单

每季度做一次，逐项打勾：

```
[ ] 随机挑一台非核心 VM，恢复到临时 VMID
[ ] 启动成功，网络/磁盘/服务正常
[ ] 数据核对：关键表行数、文件数量、最近一条记录时间
[ ] 记录恢复耗时（这就是真实 RTO）
[ ] 验证备份的完整性（PBS verify 或 vma list）
[ ] 检查备份保留策略是否按预期执行
[ ] 检查备份目录容量是否够下一轮
```

### 一句话总结

PVE 的备份很容易配，难的是**"确定它真能还原"**。把恢复演练做成季度例行，比多买一块盘有用得多。
