---
title: 节点 NotReady 与资源压力：K8s 侧的五层排查
description: 从 node status 到 kubelet、容器运行时、内核，一条自下而上的排查路径。
date: 2026-07-10
tags: [Kubernetes, 排障]
---

### 现象分类

```
① 节点 NotReady（调度不上去）
② 节点 MemoryPressure / DiskPressure
③ Pod 大量 Evicted
④ 节点上的 Pod 无故重启
```

### 第一层：节点状态

```bash
kubectl get nodes
kubectl describe node <node> | sed -n '/Conditions/,/Addresses/p'
kubectl describe node <node> | grep -A5 "Allocated resources"
```

**Conditions 里出现的条目就是根因线索**：

```
MemoryPressure  ：内存压力
DiskPressure    ：磁盘/镜像空间不足
PIDPressure     ：进程数过多
NetworkUnavailable：CNI 未就绪
Ready=False     ：kubelet 未上报正常状态
```

### 第二层：kubelet

```bash
systemctl status kubelet
journalctl -u kubelet -n 100 --no-pager
journalctl -u kubelet | grep -iE "error|fail|PLEG"
```

**高频三类**：

```
① PLEG is not healthy（容器运行时无响应）
② failed to get image（拉镜像失败/认证失败）
③ cgroup 相关错误（cgroup v1/v2 混用）
```

**"PLEG not healthy"通常指向容器运行时（containerd/docker）卡住**。

### 第三层：容器运行时

```bash
systemctl status containerd
journalctl -u containerd -n 100 --no-pager
crictl ps -a | head
crictl info | head
```

**常见**：

```
① containerd 卡在 unpack（镜像层太多/磁盘 IO 慢）
② 磁盘满导致 snapshotter 写入失败
③ /var/lib/containerd 所在盘 inode 耗尽
```

### 第四层：磁盘与 inode

```bash
df -h
df -i
du -sh /var/lib/containerd /var/log /var/lib/kubelet 2>/dev/null
```

**"df 看着有空间但写不进"** → 常见于：

```
① inode 耗尽（df -i 100%）
② 保留块（ext4 默认 5% 仅 root 可用）
③ 被删除但仍被进程持有的文件（du 与 df 不一致）
```

排查"被持有的文件"：

```bash
lsof +L1 | sort -k7 -n | tail
```

### 第五层：内存与 OOM

```bash
dmesg -T | grep -i "out of memory"
journalctl -k | grep -i kill
cat /sys/fs/cgroup/memory.events    # cgroup v2
```

**K8s 的驱逐与内核 OOM 是两套机制**：

```
kubelet eviction：按 evictionHard 阈值驱逐 Pod
内核 OOM Killer：直接 kill 进程（可能杀掉关键组件）
```

**"节点上的 Pod 一起被杀"** → 更像内核 OOM（不是驱逐）。

### 常见的"看起来很奇怪"的现象

**① 一个节点上 Pod 全 Restart**

```
节点 NotReady → Pod 被驱逐到别处 → 节点恢复后又被调度回来
```

**② 镜像拉不下来但其他节点正常**

```
该节点的 containerd 认证配置缺失 / 磁盘满 / DNS 不通
```

**③ 节点 Ready 但 Pod 起不来**

```
污点（taint）、亲和性（affinity）、资源不足
```

```bash
kubectl describe node <node> | grep -i taint
```

**④ 磁盘压力持续但删了镜像没缓解**

```
未跑 kubelet 的 image GC 或 containerd GC
→ 需要清理 + 确认 GC 配置
```

### 一个"快速定位"的顺序

```
1) kubectl describe node → 看 Conditions
2) journalctl -u kubelet → 看 PLEG/镜像/cgroup
3) systemctl status containerd + crictl ps → 运行时是否健康
4) df -h / df -i / lsof +L1 → 空间与 inode
5) dmesg → 内核 OOM
```

**"自下而上"比"猜"快得多**。

### 检查清单

```
□ 节点 Conditions 有监控告警
□ kubelet/containerd 日志集中采集
□ 磁盘与 inode 双指标告警
□ 镜像 GC 已配置
□ 驱逐阈值合理（不与应用内存打架）
□ 内核 OOM 有记录
□ 节点有"排水（drain）"流程
□ 关键组件（kubelet/containerd）有重启策略与看护
```
