---
title: Proxmox VE 集群与 HA：把"虚拟机挂了自动重启"做出来
description: 集群通信与 quorum 的作用、HA 组的资源编排、迁移与共享存储的关系、以及"HA 不生效"的五个真实原因。
date: 2026-11-27
tags: [Proxmox, 虚拟化, HA, 高可用]
---

### PVE 集群的三条通信路径

```
① Corosync（集群心跳与成员管理）  端口 5405/UDP，必须低延迟
② pmxcfs（集群配置同步）           /etc/pve 是 FUSE 挂载
③ 迁移/复制（数据面）              通常走独立网段
```

要求：

- **≥3 节点**才能形成稳定的 quorum（两节点集群加仲裁盘 `qdevice`）。
- Corosync 网络**必须独立**，与业务/存储网分开。混用会出现"心跳抖动导致节点被踢"。

```bash
pvecm status        # 看 quorum 与节点列表
pvecm nodes
```

`Expected votes` 与 `Total votes` 必须满足 quorum（多数派），否则整个集群进入只读保护状态——**这时候虚拟机可以继续跑，但改配置会失败**。

### quorum 丢失会怎样

```
三个节点，挂掉两个 → 剩一个，无多数派 → quorum lost
```

表现：

- 不能启动/停止 VM，不能改配置。
- 但已运行的 VM 不会停（这是设计上的保守选择）。

恢复办法：

```bash
pvecm expected 1     # 临时降低期望票数（仅在确认其他节点真的挂了时）
```

**不要长期改 expected 值**，那会让脑裂时的判断失效。

### 共享存储：HA 迁移的前提

HA 的本质是"节点挂了，VM 在另一个节点重新启动"。VM 的磁盘在挂掉节点的本地盘上，就起不来。

所以先要共享存储：

| 方案 | 适用 |
| --- | --- |
| NFS/CIFS | 小规模、简单 |
| iSCSI + LVM | 中小规模、需要块性能 |
| Ceph RBD | 大规模、可扩展 |
| ZFS over iSCSI | 中等规模、需要快照 |

**本地盘也能做 HA**（用 `pve-ha-manager` 的 replication 功能做 ZFS 复制），但切换时会回退到上次复制点，**丢失最近几分钟数据**。

### 配置 HA

```bash
# ① 添加 HA 资源（VM 100 自动重启）
ha-manager add vm:100 --state started

# ② 设置重启策略
ha-manager set vm:100 --max_restart 3 --max_relocate 2

# ③ 查看 HA 状态
ha-manager status
```

参数含义：

- `max_restart`：同一节点上尝试重启的次数（本地故障）。
- `max_relocate`：跨节点迁移的尝试次数。
- `state started`：期望状态（HA 会持续收敛到该状态）。

分组（HA Group）用于把某些 VM 绑定到特定节点集合：

```bash
ha-manager groupadd web-group --nodes pve1,pve2 --restricted
```

`--restricted` 表示严格限制在这两个节点，不满足就报错而不是随便跑。

### 五个"HA 不生效"的原因

**① VM 磁盘在本地存储**

```bash
qm config 100 | grep -E 'scsi|virtio|ide'
# 看存储名是不是 local / local-lvm（本地）
```

本地盘 → 目标节点没有磁盘 → HA 启动失败，日志报 `storage not available`。

**② 没开 HA，只是"开机自启"**

`onboot=1` 是"节点启动时拉起 VM"，与"节点故障时在别处重启"是两件事。很多人混淆。

**③ VM 处于 locked 状态**

迁移/备份中断会留下锁：

```bash
qm unlock 100
```

**④ 网络不通或 quorum 丢失**

HA manager 需要 quorum 才能做决策。三个节点挂两个 = 无法决策。

**⑤ 资源组绑定太死**

`--restricted` 组里所有节点都挂了 → 不会跑到组外，等于没有 HA。

### 迁移：在线 vs 离线

```bash
# 在线迁移（需要共享存储或本地盘实时迁移）
qm migrate 100 pve2 --online

# 离线迁移（停机）
qm migrate 100 pve2
```

在线迁移的两条路径：

- **共享存储**：只迁移内存状态，快（秒级）。
- **本地盘**：需要传磁盘，慢（分钟级），且要求同型号 CPU 或开启 `--with-local-disks`。

CPU 类型不一致会导致迁移后 VM 起不来：

```bash
# VM 配置里设为兼容模式
qm set 100 --cpu host        # 同型号集群可用 host，否则用 kvm64/x86-64-v2
```

### 备份要跟 HA 一起设计

HA 解决"节点挂了"，不解决"数据错了"。

```bash
# 定时备份到 PBS（Proxmox Backup Server）
vzdump 100 --storage pbs --mode snapshot --compress zstd
```

三个原则：

1. **备份到独立设备**（PBS/NFS/异地），不要和被备份的 VM 同盘。
2. **快照模式备份**（`--mode snapshot`），避免长时间停机。
3. **定期恢复演练**，至少每季度一次。

### 一个真实故障复盘

现象：pve2 宕机，上面的 6 台 VM 没有自动重启。

排查顺序：

```bash
ha-manager status
# 显示 service vm:102 error "unable to start - storage 'ceph' not available"
```

原因：pve2 的 Ceph MON 也在上面，pve2 宕机后 Ceph 集群降到 2 个 MON，虽然还能工作，但新节点挂载 RBD 超时，导致 HA 启动失败。

修法：

1. Ceph MON 至少 3 个且**不与 PVE 节点强绑定**（独立小机器或至少打散）。
2. HA 启动加延迟，避免所有 VM 同时拉起压垮存储。
3. 加监控：MON quorum 数量、RBD 挂载延迟。

教训：**HA 依赖的每一层，本身也必须是高可用的**。PVE 的 HA 只是最后一环。
