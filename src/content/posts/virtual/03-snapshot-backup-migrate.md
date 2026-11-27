---
title: 快照、备份与迁移：虚拟化环境的数据安全线
description: 三种机制各自的作用域与失效场景，配 PVE 备份计划、NFS 共享存储与离线迁移的落地做法。
date: 2026-11-22
tags: [虚拟化, 备份, 快照, 迁移, 存储]
---

### 三种机制，别混着用

| 机制 | 作用 | 放在哪 | 失效场景 |
| --- | --- | --- | --- |
| 快照 Snapshot | 记录某刻磁盘状态，可秒级回滚 | 同一存储 | 存储损坏、快照链过长 |
| 备份 Backup | 完整数据副本，可异机恢复 | 独立存储/远端 | 备份任务未验证 |
| 复制 Replication | 把虚机同步到另一节点 | 另一台物理机 | 两节点同时故障 |

一句话：**快照防变更事故，备份防存储事故，复制防单机事故**。三者是不同层，不是替代关系。

### PVE 里配一套自动备份

Web 界面 `Datacenter → Backup → Add`：

```text
存储：/backup（独立盘或 NFS）
计划：每天 02:30
选择：全部虚机
模式：snapshot（在线，不断业务）
压缩：zstd
保留：keep-last=7, keep-weekly=4
```

命令行等价：

```bash
vzdump 101 102 --mode snapshot --compress zstd \
  --storage backup-store --mailto ops@example.com
```

查看备份内容：

```bash
ls -lh /backup/dump/
# vzdump-qemu-101-2026_11_22-02_30_05.vma.zst
```

**恢复测试**是备份唯一有效的检验方式。每月挑一台最小虚机恢复到临时 VMID，能起来才算备份有效。

### 共享存储：NFS 还是 iSCSI

| | NFS | iSCSI |
| --- | --- | --- |
| 类型 | 文件级 | 块级 |
| 多节点同时用 | 支持（需正确锁） | 需集群文件系统或 LVM 独占 |
| 上手难度 | 低 | 中 |
| 适合 | 备份、ISO、模板 | 数据库、需要块设备的场景 |

小规模私有云，NFS 就够，配好后加进 PVE：

```bash
# NAS/存储服务器上
apt install nfs-kernel-server
echo "/data/pve *(rw,sync,no_subtree_check)" >> /etc/exports
exportfs -ra

# PVE 上
pvesm add nfs pve-nfs --server 192.168.1.20 --export /data/pve --content backup,iso,vztmpl
```

### 迁移：在线还是离线

```bash
# 离线迁移（虚机需关机），没有共享存储也能做
qm migrate 101 pve2 --online 0

# 在线迁移需要共享存储或本地磁盘迁移
qm migrate 101 pve2 --online 1 --with-local-disks
```

在线迁移失败的常见原因：目标节点存储名不一致、网络带宽不足、CPU 型号差异导致需要 `--host` 参数放宽检查。

### 容量规划：别等到 90% 才想

```text
磁盘：单节点使用率 ≤ 70%，留出快照与迁移的空间
内存：所有虚机内存之和 ≤ 物理内存 × 1.3（超分留余量）
CPU：vCPU 总数 ≤ 物理核数 × 2
网络：迁移走独立万兆或至少千兆独占
```

超分是为了提高利用率，但**超分必须有监控**——内存超分过头会触发 OOM killer，一次干掉三台虚机。

### 事故场景复盘

```text
现象：周一早上文件服务器虚机无法启动
查因：/data 存储损坏，快照与虚机磁盘在同一块盘上
结果：快照一起丢，只能从未验证的历史备份恢复，丢失两天数据
改进：备份独立物理盘 + 每周恢复演练 + 快照保留不超过 3 个
```

### 本章要点

- 快照、备份、复制是三层不同的保险，不能互相替代。
- 备份必须定期做**恢复演练**，否则只是心理安慰。
- NFS 适合备份与模板，iSCSI 适合块设备需求。
- 超分要有监控，否则 OOM 会一次带走多台虚机。
