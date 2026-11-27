---
title: 第 8 章 · 弹性与容量：HPA、KEDA 与"扩容没用"
module: 熟练篇
summary: HPA 算法与防抖、自定义指标、KEDA 事件驱动、容量核算与五个"扩了没效果"的原因。
minutes: 45
---

### HPA 的算法

```
期望副本 = ceil(当前副本 × 当前指标 / 目标指标)
```

**"扩了但延迟没降"** → 新副本还在启动（冷启动时间）。

### 一个"防抖"的 HPA

```yaml
behavior:
  scaleUp:
    stabilizationWindowSeconds: 30
    policies: [{type: Percent, value: 100, periodSeconds: 15}]
  scaleDown:
    stabilizationWindowSeconds: 300
    policies: [{type: Pods, value: 1, periodSeconds: 60}]
```

**`scaleDown` 的窗口更长** → 避免"刚缩完又来流量"。

### 自定义指标

```yaml
metrics:
- type: Pods
  pods:
    metric: {name: http_requests_per_second}
    target: {type: AverageValue, averageValue: 100}
```

**"CPU 不高但用户慢"** → CPU 指标不能反映瓶颈（用 QPS/延迟/队列）。

### KEDA：队列驱动

```yaml
triggers:
- type: kafka
  metadata:
    bootstrapServers: kafka:9092
    consumerGroup: workers
    topic: jobs
    lagThreshold: "100"
```

**判据**：

```
有明确"积压量"的场景（队列/任务）→ KEDA 比 HPA 准
```

### 容量核算

```
① request 总和 ≤ 节点可分配 × 80%
② 留 N+1（挂一台仍能跑）
③ 峰值 × 1.5
④ 滚动发布时"新旧共存"的瞬时峰值
```

```bash
kubectl describe node | grep -A6 "Allocated resources"
```

### 五个"扩了没效果"

**① request 缺失**

```
HPA 无法计算利用率
```

**② maxReplicas 太小 / 节点不足**

```
Pod Pending，等于没扩
```

**③ 瓶颈在下游**

```
DB 连接池/缓存打满 → 加副本只是加压力
```

**④ 冷启动太长**

```
扩容完成时高峰已过
```

**⑤ 指标滞后**

```
metrics-server 15s + HPA 15s → 半分钟
```

### 本章检查清单

```
□ 有 request/limit
□ HPA 有 behavior
□ 指标贴合业务
□ maxReplicas 与容量匹配
□ 有冷启动时间评估
□ 下游有连接池上限
□ 队列类用 KEDA
□ 有扩缩容事件记录
□ 留 N+1 余量
□ 有压测验证扩容效果
```
