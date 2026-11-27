---
title: Ceph 入门：分布式存储到底解决了什么问题
description: Ceph 的三个组件与两种用法、CRUSH 与 PG 的概念、三副本 vs 纠删码、最小可用集群的搭建顺序，以及"能用"和"好用"的差距。
date: 2022-12-19
tags: [Ceph, 分布式存储, 对象存储, 块存储]
---

### 一句话讲清 Ceph

Ceph 把一堆普通服务器的磁盘**组成一个统一的大存储池**，并对外提供三种接口：

| 接口 | 用途 | 类比 |
| --- | --- | --- |
| RADOS（对象） | 底层，一切的基础 | 键值存储 |
| RBD（块） | 给虚拟机/容器挂盘 | 一块"云硬盘" |
| CephFS（文件） | 共享文件系统，可多客户端同时挂载 | NFS 的强化版 |
| RGW（对象网关） | 提供 S3/Swift 兼容接口 | 自建对象存储 |

它的价值在三个场景：

1. **KVM/Proxmox 集群的共享存储**（迁移、快照、高可用）。
2. **海量非结构化数据的对象存储**（图片、备份、归档）。
3. **需要横向扩容的文件共享**。

### 三个组件

```
MON（Monitor）   ：维护集群地图（谁是活的、数据在哪）
OSD（Object Store Daemon）：一块磁盘 = 一个 OSD，真正存数据、做复制
MDS（Metadata Server）：仅 CephFS 需要，管目录元数据
```

最小生产规模：

- **3 个 MON**（奇数，多数派投票）。
- **至少 3 个 OSD 节点，每节点多块盘**。
- 不要 "MON 与 OSD 全在一台机器上" —— 那只是玩具集群。

### CRUSH 与 PG：数据到底落在哪

**CRUSH** 是 Ceph 的"数据分布算法"：给定一个对象名，算出它应该落在哪些 OSD。它不依赖中心索引，所以扩容时只需重算并迁移一部分数据。

中间有个关键概念 **PG（Placement Group）**：

```
对象 → 哈希 → PG（固定数量，如 512 个）→ CRUSH → OSD 列表
```

为什么要中间层：如果每个对象直接映射到 OSD，几亿对象就需要几亿条映射记录。用 PG 做聚合，元数据量从"对象级"降到"PG 级"。

PG 数量的经验公式（每 OSD 约 100 个 PG）：

```
PG 总数 ≈ (OSD 数量 × 100) / 副本数
```

举 12 块盘、3 副本：`12 × 100 / 3 = 400` → 取 2 的幂，512。

**PG 数量定好之后尽量别改**：改 PG 数会触发大规模数据重平衡，生产上很痛。

### 三副本 vs 纠删码

| | 三副本 | 纠删码（k+m） |
| --- | --- | --- |
| 空间效率 | 33% | 例如 4+2 = 67% |
| 写性能 | 好 | 差（要算校验） |
| 恢复开销 | 小 | 大（重建要读多块） |
| 适合 | 虚拟机的块存储、热数据 | 归档、冷数据、对象存储 |

判断标准：**写入频繁且延迟敏感 → 副本；容量敏感且读多写少 → 纠删码**。

不要在一个池里混用两种，也不要为了省空间把 RBD 放纠删码池（虚拟机 IO 会明显变慢）。

### 搭建顺序（最小可用）

以 3 节点为例，每节点 4 块盘：

```bash
# ① 前置：主机名、时间同步、互信、关闭 swap（或调低 swappiness）
# ② 安装
apt install -y ceph ceph-common

# ③ 初始化 MON（在 node1 上）
ceph-deploy new node1 node2 node3     # 老工具；新版用 cephadm
ceph-deploy mon create-initial

# ④ 部署 OSD
ceph-deploy osd create --data /dev/sdb node1
# ⑤ 部署 MGR
ceph-deploy mgr create node1
```

新版（cephadm，推荐）：

```bash
cephadm bootstrap --mon-ip 10.0.0.11
ceph orch host add node2 10.0.0.12
ceph orch apply osd --all-available-devices
```

### 验证"真的好用"的四项

搭起来不代表可用，必须验证：

**① 健康状态**

```bash
ceph -s
# HEALTH_OK / HEALTH_WARN / HEALTH_ERR
ceph health detail
```

**② 数据重平衡是否收敛**

```bash
ceph -w    # 观察 recovery / backfill 速率
```

**③ 单盘故障演练**

```bash
# 拔一块盘或标记 out
ceph osd out 3
ceph -s      # 观察是否自动重建，多久回到 HEALTH_OK
```

**④ 性能基线**

```bash
rados bench -p rbdpool 60 write -b 4M -t 16
rbd bench --io-type write --io-size 4K --io-total 1G rbd/test
```

没有基线，出问题时无法判断"慢"是正常还是异常。

### 生产上最容易踩的三件事

1. **网络**：Ceph 的 public 网（客户端访问）与 cluster 网（数据复制）**必须分开**。混在一起时，一次重平衡会把客户端访问拖死。至少 10GbE，全闪存建议 25GbE。

2. **MON 与 OSD 抢资源**：MON 对延迟极敏感，不要和重 IO 的 OSD 混在同一台。三台 MON 独立小机器最稳。

3. **PG 数与 OSD 增长不匹配**：加盘后 PG 不变，导致每 PG 覆盖的 OSD 过多，恢复变慢。规划时留余量。

### 什么时候不该用 Ceph

- 只有 2 台服务器 → 用本地 ZFS + 复制，比 Ceph 简单得多。
- 只要共享文件、性能要求不高 → NFS/SMB 足够。
- 团队没人愿意学 → 运维成本会超过收益。

**Ceph 的门槛不在搭建，而在故障时的判断**（PG 不一致、slow ops、near full）。上生产前至少做过一次"拔盘 + 换盘 + 重平衡"的完整演练。
