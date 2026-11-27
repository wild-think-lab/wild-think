---
title: Proxmox VE：把一台机器变成一个小型私有云
description: 装完必做的八项设置、集群与 Ceph 集成、备份与快照、以及五个"生产用不起来"的原因。
date: 2024-04-04
tags: [虚拟化, Proxmox, 私有云]
---

### 它是什么

```
Proxmox VE（PVE）：基于 Debian 的开源虚拟化平台
支持：KVM 虚拟机 + LXC 容器 + 集群 + Ceph 存储
```

**对比**：

| 维度 | PVE | VMware vSphere | OpenStack |
| --- | --- | --- | --- |
| 成本 | 免费（订阅可选） | 昂贵 | 免费但复杂 |
| 上手 | 简单（Web UI） | 简单 | 很难 |
| 功能 | 中（够用） | 全 | 全但分散 |
| 规模 | 小中（≤ 几十节点） | 中大 | 大 |

**结论**：**几十台以内的小型私有云，PVE 是性价比最高的选择**。

### 装完必做的八项

**① 换国内源（否则更新很慢）**

```bash
# 注释企业源
sed -i 's/^/#/' /etc/apt/sources.list.d/pve-enterprise.list

# 加免费源
echo "deb http://download.proxmox.com/debian/pve bookworm pve-no-subscription" \
  > /etc/apt/sources.list.d/pve-no-sub.list
apt update
```

**② 去掉订阅提示**（仅视觉，不改功能）

```bash
sed -i.bak "s/Ext.Msg.show({/void({/g" \
  /usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js
systemctl restart pveproxy
```

**③ 配置管理网卡绑定**

```
物理口做 bond（mode=active-backup 或 LACP）
→ vmbr 桥接在 bond 上
→ 管理 IP 与虚机网络分离（更安全）
```

**④ 关闭 swap 或调低 swappiness**

```bash
sysctl -w vm.swappiness=10
```

**⑤ 时间同步**

```bash
apt install chrony
systemctl enable --now chrony
```

**⑥ 限制 root 直连（改用普通账号 + sudo）**

**⑦ 配邮件通知**

```
Datacenter → Options → Email notification
（备份失败/节点异常会发邮件）
```

**⑧ 配备份任务**

```
Datacenter → Backup → Add
（每天到 NAS/对象存储，保留 N 份）
```

**"没配备份的 PVE"只是一台"随时会丢数据的宿主机"**。

### 集群

```bash
# 在第一个节点
pvecm create cluster1

# 其他节点加入
pvecm add 10.0.0.1
```

**集群的要求**：

```
① 节点间延迟 < 2ms（同机房）
② 独立的心跳网络（不要与管理网共用）
③ 奇数节点（3/5/7，避免脑裂）
```

**"跨机房组 PVE 集群"几乎必然出问题**：

```
延迟高 → corosync 频繁超时 → 节点被踢 → 集群不稳定
```

**跨机房应该做"两地独立集群 + 异步复制"**。

### 存储的三种选择

```
① local（本地盘）：单机，不共享
② NFS/iSCSI（外部存储）：共享，但性能取决于外部
③ Ceph（超融合）：推荐，PVE 与 Ceph 集成很好
```

**Ceph 的最小规模**：

```
至少 3 节点（MON 需要多数）
每节点至少 1 块独立 SSD/HDD 给 Ceph
网络：万兆（Ceph 对网络很敏感）
```

**"单节点装 Ceph"** 可以用于实验，但**不具备冗余**。

### 备份与快照（两者的区别要清楚）

```
快照（Snapshot）：记录某一时刻状态，用于"回滚"（不独立，依赖原盘）
备份（Backup）  ：完整导出到另一个位置，用于"灾难恢复"
```

**"只有快照不算备份"**：

```
原盘损坏 → 快照一起丢
```

**备份策略**：

```
① 保留 3–7 份（不能都放同一存储）
② 至少一份"离线/异地"
③ 定期演练恢复（否则备份等于没有）
```

```bash
# 命令行备份
vzdump 100 --storage backup-nfs --mode stop --compress zstd

# 恢复
qmrestore /path/vzdump-qemu-100-xxx.vma.zst 100
```

**`--mode stop` vs `snapshot`**：

```
stop     ：停机备份（一致性最好）
snapshot ：在线快照备份（不停机，但依赖存储快照能力）
suspend  ：短暂挂起（折中）
```

### 虚拟机 vs 容器

```
KVM（VM）  ：完整虚拟化，可跑任何系统，隔离强
LXC（容器）：共享内核，轻量，性能好，但隔离弱
```

**选择**：

```
需要 Windows / 不同内核 / 强隔离 → VM
Linux 服务且追求密度 → LXC
```

**LXC 的权限**：

```
privileged（特权）容器 → 性能与灵活性好，但逃逸风险高
unprivileged（非特权）→ 更安全（推荐）
```

**生产建议用 unprivileged**，并开启 `features: nesting=1`（如果需要 Docker inside）。

### 五个"生产用不起来"的原因

**① 没有独立心跳网络**

```
管理网一抖，集群就分裂
→ 加一根独立网线做 corosync
```

**② 存储单点**

```
local 盘挂了 → VM 全丢
→ 上 Ceph 或共享存储 + 备份
```

**③ 网络单点**

```
单网卡、单交换机
→ 做 bond + 双交换机（堆叠或 MLAG）
```

**④ 没有容量规划**

```
VM 数量上去后 CPU/内存超卖 → 全部变慢
→ 按"实际用量 + 30% 余量"规划
```

**⑤ 没有监控**

```
PVE 自带界面看不到趋势
→ 接 Prometheus（pve_exporter）+ Grafana
```

### 监控接入

```bash
# pve_exporter
pve-exporter --config /etc/pve-exporter.yml
# Prometheus 抓 :9221
```

**关键指标**：

```
节点 CPU/内存
VM 的 CPU/内存/磁盘 IO
存储使用率（尤其是 Ceph 的接近满）
备份任务成功/失败
```

### 一个"小而稳"的架构

```
3 台同配置机器（每台 8C/64G/2×1TB SSD + 2×4TB HDD）
  网络：2×10G bond
  存储：Ceph（3 副本）+ 独立心跳网
  备份：一台 NAS + 一份异地
  监控：Prometheus + Grafana + Alertmanager
```

**这个规模能跑 30–50 个中等 VM**，成本远低于同等 VMware 方案。

### 检查清单

```
□ 换国内源、去订阅提示
□ bond + vmbr（管理与业务分离）
□ chrony 时间同步
□ 邮件通知
□ 每天自动备份到外部
□ 至少一份异地/离线备份
□ 集群：独立心跳网 + 奇数节点
□ 同机房组集群（不跨机房）
□ Ceph：3 节点起、万兆网
□ 快照 ≠ 备份（认知正确）
□ LXC 用 unprivileged
□ 接 Prometheus 监控
□ 恢复演练过
```
