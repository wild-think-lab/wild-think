---
title: HPA 与 VPA：弹性伸缩为什么经常"不灵"
description: HPA 的指标与算法、VPA 的三种模式、五个"扩了没效果"的原因、KEDA 事件驱动扩缩。
date: 2026-10-21
tags: [Kubernetes, 弹性, 容量]
---

### HPA 的算法

```
期望副本数 = ceil(当前副本 × 当前指标 / 目标指标)
```

**例子**：

```
当前 4 副本，CPU 80%，目标 50% → 4 × 80/50 = 6.4 → 7
```

**"扩了没降"** 是因为：新副本的 Pod 还没真正分担负载（启动期）。

### 一个可用的 HPA

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: {name: app-hpa}
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: app}
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource: {name: cpu, target: {type: Utilization, averageUtilization: 60}}
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies: [{type: Percent, value: 100, periodSeconds: 30}]
    scaleDown:
      stabilizationWindowSeconds: 300
      policies: [{type: Pods, value: 2, periodSeconds: 60}]
```

**`behavior`** 是防抖的关键（没有它会出现"扩缩抖动"）。

### 五个"扩了没效果"

**① 指标选错**

```
CPU 不高但延迟高（IO 等待）→ HPA 不扩
→ 用自定义指标（QPS/排队/延迟）
```

**② request 没设或设太小**

```
HPA 的 CPU 利用率是"占 request 的百分比"
request 缺失 → HPA 无法计算
```

**③ 副本有上限**

```
maxReplicas 太低 / 节点资源不足（Pending）
```

**④ 冷启动太长**

```
扩出来 3 分钟才可用 → 高峰已经过了
```

**⑤ 指标采集延迟**

```
metrics-server 15s 一次 + HPA 15s 同步 → 半分钟滞后
```

### 自定义指标（Prometheus Adapter）

```yaml
metrics:
- type: Pods
  pods:
    metric: {name: http_requests_per_second}
    target: {type: AverageValue, averageValue: 100}
```

**"QPS 每 Pod 100"** 比 CPU 更贴合业务。

### VPA 的三种模式

```
Off        只给建议（不自动改）
Initial    只在创建时设置
Recreate   变更时重建 Pod（会中断！）
Auto       自动（等价 Recreate）
```

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata: {name: app-vpa}
spec:
  targetRef: {apiVersion: apps/v1, kind: Deployment, name: app}
  updatePolicy: {updateMode: "Off"}   # 先只看建议
```

**"VPA + HPA 同时用同一指标"** 会互相打架（VPA 改 request，HPA 改副本）。

### 组合策略（推荐）

```
HPA：按业务指标扩副本（横向）
VPA（Off 模式）：给出 request 建议，人工审核后应用
```

**"VPA 自动 + HPA"** 不推荐（除非明确分开指标）。

### KEDA：事件驱动

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: {name: worker-scaler}
spec:
  scaleTargetRef: {name: worker}
  minReplicaCount: 0
  maxReplicaCount: 30
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka:9092
      consumerGroup: workers
      topic: jobs
      lagThreshold: "100"
```

**"队列堆积就扩，队列空就缩到 0"** —— 批处理场景最合适。

### 检查清单

```
□ 每个 Deployment 都设了 request/limit
□ HPA 有 behavior（防抖）
□ 指标贴合业务（不是只看 CPU）
□ maxReplicas 与节点容量匹配
□ 有"扩容后可用时间"的预估
□ VPA 先用 Off 观察
□ VPA 与 HPA 不冲突
□ 批处理用 KEDA（事件驱动）
□ 有 HPA 扩缩事件记录（便于复盘）
□ 冷启动有预热/常驻最小副本
```
