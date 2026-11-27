---
title: 调度与资源治理：让 Pod 落在该在的节点
module: 进阶篇
summary: requests/limits 与 QoS、亲和与反亲和、污点与容忍、PDB 与优先级，五个"调度看起来随机"的原因。
minutes: 50
---

### 调度先看 requests

```yaml
resources:
  requests: { cpu: 500m, memory: 512Mi }
  limits:   { cpu: "2",  memory: 1Gi }
```

```
requests：调度依据（节点剩余可分配量）
limits：运行时上限（CPU 限流、内存 OOMKill）
```

**"只写 limits 不写 requests"** → 调度按默认小值放置，节点超卖。

### QoS 三档

```
Guaranteed：requests == limits（全部资源）
Burstable：requests < limits（最常见）
BestEffort：都没设（最先被驱逐）
```

**判据**：核心服务给 Guaranteed 或接近；离线任务给 BestEffort。

### 亲和与反亲和

```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
        - matchExpressions:
            - { key: disktype, operator: In, values: [ssd] }
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels: { app: order }
          topologyKey: kubernetes.io/hostname
```

**反亲和 + hostname** = 同一服务尽量分散到不同节点（高可用）。

**"用 nodeName 钉死"** → 绕过调度器，节点挂了不会重建到别处。

### 污点与容忍

```bash
kubectl taint nodes node1 dedicated=gpu:NoSchedule
```

```yaml
tolerations:
  - { key: dedicated, operator: Equal, value: gpu, effect: NoSchedule }
```

**用途**：专用节点（GPU/数据库/网关）不被普通 Pod 占用。

```bash
kubectl describe node node1 | grep -A3 Taints
```

**"Pod Pending 但节点看着空"** → 检查污点与可分配资源。

### 优先级与抢占

```yaml
priorityClassName: system-cluster-critical
```

**用于**：核心组件（CNI、监控 agent）在资源紧张时优先保留。

### PDB（中断预算）

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: order }
spec:
  minAvailable: 2
  selector: { matchLabels: { app: order } }
```

**作用**：节点维护/驱逐时保证最少可用副本。**没有它** → 一次 drain 可能全下。

### 五个"调度看起来随机"

**① 资源碎片**

```
节点总空闲够，但单节点不够 → Pending
```

**② 拓扑分布约束没设**

```
3 副本全在同一节点 → 节点挂了全没
```

```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector: { matchLabels: { app: order } }
```

**③ 镜像拉不下来**

```
Pending/ImagePullBackOff（看 events）
```

**④ 亲和条件互相矛盾**

```
nodeAffinity 要 ssd，nodeSelector 要 hdd
```

**⑤ 配额打满**

```
ResourceQuota / LimitRange 拦住新建
```

### 排查顺序

```bash
kubectl describe pod <pod> | tail -20     # Events 里写原因
kubectl get nodes -o wide
kubectl describe node <node> | grep -E "Allocated|Taints"
kubectl get resourcequota -A
```

### 检查清单

```
□ 所有业务 Pod 有 requests/limits
□ 核心服务 QoS 合理
□ 有反亲和/拓扑分布（高可用）
□ 专用节点用污点
□ 核心组件有 priorityClass
□ 有 PDB（保障维护期可用）
□ 有 ResourceQuota（防单 ns 吃满）
□ Pending 有告警
□ 调度事件可查（describe events）
□ 节点标签规范（机型/区域/用途）
```
