---
title: 第 1 章：调度、探针与资源
module: 入门篇
summary: 调度器怎么选节点、三类探针的差别、request/limit 的 QoS 影响，以及 nodeSelector / 亲和性的取舍。
minutes: 45
---

### 调度器只看三件事

```
① 资源是否够（request 总和 ≤ 节点可分配）
② 约束是否满足（亲和性/污点/选择器）
③ 打分排序（选"最合适"的那个节点）
```

**"Pod 一直 Pending"** → 99% 是前两条不满足。

### 三类探针

```
liveness    活着吗（不活就重启）
readiness   能服务吗（不能就摘流量）
startup     启动完成了吗（防"启动慢被误杀"）
```

**最常犯的错**：用 liveness 检查"依赖是否可用"（依赖挂了 → 把自己重启死循环）。

```
liveness 只查"进程是否卡死"
readiness 才查"依赖是否可用"
```

### 一个"不误杀"的配置

```yaml
livenessProbe:
  httpGet: {path: /healthz, port: 8080}
  initialDelaySeconds: 20
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: {path: /ready, port: 8080}
  periodSeconds: 5
  failureThreshold: 3
startupProbe:
  httpGet: {path: /healthz, port: 8080}
  failureThreshold: 30
  periodSeconds: 2   # 最多给 60s 启动时间
```

**startupProbe 存在时**，liveness 会在它成功后才开始计时。

### request 与 limit

```
request：调度依据（"保证"的资源）
limit：运行上限（超了会被限流/杀）
```

**QoS 三类**（决定了"资源紧张时先杀谁"）：

```
Guaranteed  request==limit（最关键业务）
Burstable   有 request 但 limit 更大
BestEffort  都没设（最先被杀）
```

**"什么都没设"** → 节点紧张时第一个被 OOM kill。

### 一个"生产可用"的资源块

```yaml
resources:
  requests: {cpu: 100m, memory: 256Mi}
  limits: {cpu: "1", memory: 512Mi}
```

**"cpu limit = 1"** 会让容器被 CFS 限流（注意 P99 抖动）；对延迟敏感的服务可以只设 request 不设 cpu limit（但要接受"节点公平竞争"）。

### 调度约束

```yaml
nodeSelector: {disktype: ssd}
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - {key: gpu, operator: In, values: ["true"]}
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        topologyKey: kubernetes.io/hostname
        labelSelector: {matchLabels: {app: myapp}}
```

**"podAntiAffinity"** 让副本分散到不同节点（避免一台挂了全挂）。

### 污点与容忍

```bash
kubectl taint nodes node-1 dedicated=gpu:NoSchedule
```

```yaml
tolerations:
- {key: dedicated, operator: Equal, value: gpu, effect: NoSchedule}
```

**"专用节点"** 用污点实现，比"只靠 label"更硬。

### 本章检查清单

```
□ 每个工作负载都有 request
□ liveness 只查进程，readiness 查依赖
□ 启动慢的有 startupProbe
□ 关键业务是 Guaranteed
□ 副本有反亲和（分散节点）
□ 专用节点用污点
□ 有 Pending Pod 的巡检
```
