---
title: 第 5 章：节点故障与容量
module: 熟练篇
summary: NotReady 的六种原因、节点隔离与恢复、驱逐与再调度、容量核算与"看起来有空其实没有"。
minutes: 45
---

### NotReady 的六种原因

```
① kubelet 挂了（进程/证书/配置）
② 容器运行时（containerd）挂了
③ 磁盘压力（DiskPressure）
④ 内存压力（MemoryPressure）
⑤ 网络插件异常（CNI 无法分配 IP）
⑥ 节点与 apiserver 通信断（心跳超时）
```

```bash
kubectl describe node node-1 | grep -A10 Conditions
# 到节点上
systemctl status kubelet containerd
journalctl -u kubelet -n 200
df -h; free -m
```

### 节点隔离（先止血）

```bash
kubectl cordon node-1          # 不再调度新 Pod
kubectl drain node-1 --ignore-daemonsets --delete-emptydir-data
```

**"直接重启节点"** 会让 Pod 在"不确定状态"下被重建（有状态服务尤其危险）。

### 驱逐与再调度

```
驱逐后 Pod 会被重建到别的节点（受 PDB、资源、亲和性约束）
有状态服务：需要"先确认卷可挂到新节点"
```

**"Pod 一直 Pending 在新节点"** → 资源不足或亲和性不满足。

### 恢复流程

```
1) cordon（隔离）
2) 排原因（kubelet/运行时/磁盘/网络）
3) 修复
4) 验证（节点 Ready + 新 Pod 能调度）
5) uncordon
6) 观察 10 分钟
```

### 容量核算（"看起来有空其实没有"）

```
① 节点可分配 ≠ 总容量（预留 + DaemonSet 占用）
② request 总和才是真实占用（不是实际使用）
③ 峰值 + 一台节点故障的余量（N+1）
④ 有状态服务不能随便漂移（卷的可用性）
```

```bash
kubectl describe node node-1 | grep -A5 "Allocated resources"
```

**判据**：

```
requested CPU > 70% → 该扩容
requested Memory > 75% → 该扩容
```

### 五类"容量假象"

**① 只看 CPU 使用率**

```
request 早就占满了，使用率低但调度不上
```

**② 忽略 DaemonSet**

```
日志/监控 agent 每节点吃 500m
```

**③ 忽略"峰值"**

```
按平均值算容量 → 高峰必挂
```

**④ 忽略"节点故障"**

```
3 节点全满 → 挂 1 台，剩下 2 台接不住
```

**⑤ 忽略"启动瞬时资源"**

```
滚动发布时新旧共存 → 瞬时超卖
```

### 本章检查清单

```
□ 有 NotReady 告警
□ 会读 node Conditions
□ cordon/drain 是标准动作
□ 关键服务有 PDB
□ 有状态服务有"卷漂移"预案
□ 按 request 核算容量
□ 留 N+1 余量
□ 有 DaemonSet 资源台账
□ 有"峰值"与"发布瞬时"的评估
□ 有节点扩容的标准流程
```
