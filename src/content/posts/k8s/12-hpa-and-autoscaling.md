---
title: HPA 与自动扩缩：为什么你的扩缩容在抖动
description: HPA 的计算公式、三个必配的稳定机制、与集群自动扩缩的配合、以及"扩了但没用"的六种原因。
date: 2026-11-27
tags: [Kubernetes, HPA, 弹性, 容量]
---

### HPA 的公式

```
期望副本数 = ceil(当前副本数 × (当前指标值 / 目标指标值))
```

例：目标 CPU 60%，当前 3 副本平均 90% → `ceil(3 × 1.5) = 5`。

**注意两个细节**：

1. 按**当前副本数**算，不是按"总使用量"。
2. 有 ±10% 的容忍带（避免频繁抖动）：实际值在目标 ±10% 内不动。

### 一个可用的配置

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: api, namespace: prod }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: api }
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target: { type: Utilization, averageUtilization: 60 }
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30      # 但要快速扩
      policies:
      - type: Percent
        value: 100                        # 一次最多翻倍
        periodSeconds: 30
      selectPolicy: Max
    scaleDown:
      stabilizationWindowSeconds: 300     # 5 分钟稳定后才缩
      policies:
      - type: Pods
        value: 1                          # 每 60 秒最多缩 1 个
        periodSeconds: 60
```

**behavior 是稳定性的关键**，没有它 HPA 会剧烈抖动。

### 三个必配的稳定机制

**① `stabilizationWindowSeconds`（稳定窗口）**

缩容前看"过去 N 秒的所有推荐值，取最大"。默认 300 秒（v2 里 scaleDown 默认 300）。

作用：一次流量尖峰过去后不会立刻缩容，避免"缩完又来流量→再扩"。

**② 扩缩策略（policies）**

```
scaleUp：允许翻倍（快，应对突发）
scaleDown：每次只缩 1 个（慢，避免误缩）
```

**③ 就绪探针与启动时间**

新 Pod 的 `readinessProbe` 没过之前不算"可用"，HPA 的副本数会等。如果应用启动要 60 秒，扩容的"有效时间"就是 60 秒后 —— **这就是"扩了但没用"的最常见原因**。

### 扩容别只看 CPU

CPU 是最容易采集但最不准确的指标：

| 指标 | 适用 |
| --- | --- |
| CPU 利用率 | CPU 密集型（计算、编解码） |
| 内存 | 缓存类（但内存通常不降，缩放无效） |
| QPS / RPS（自定义指标） | **IO 密集型、Web 服务（最准）** |
| 队列长度 | 异步消费者 |
| 延迟 | 直接对应用户体验 |

自定义指标（需要 Prometheus Adapter）：

```yaml
  metrics:
  - type: Pods
    pods:
      metric: { name: http_requests_per_second }
      target: { type: AverageValue, averageValue: "100" }
```

**Web 服务用 QPS 比 CPU 更可靠**：CPU 高可能是 GC，也可能是限流前的浪涌。

### 与集群自动扩缩配合

```
HPA：加 Pod（应用层）
Cluster Autoscaler / Karpenter：加节点（基础设施层）
```

两者的坑：

**① HPA 扩了，但节点没资源 → Pod Pending**

```
HPA 把副本从 5 提到 15
节点资源不够 → 10 个 Pod Pending
Cluster Autoscaler 需要 3–5 分钟才能加节点
→ 这 5 分钟服务容量没变
```

对策：**保留缓冲容量**（节点利用率控制在 70% 左右），或提前预热。

**② Cluster Autoscaler 缩节点，把服务 Pod 挤走**

对策：关键服务设置 PDB（PodDisruptionBudget）。

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: api-pdb, namespace: prod }
spec:
  minAvailable: 2
  selector:
    matchLabels: { app: api }
```

### "扩了但没用"的六种原因

| 现象 | 原因 |
| --- | --- |
| 副本涨了但 QPS 不涨 | 瓶颈在数据库/下游，不在应用 |
| 新 Pod 一直 Pending | 节点没有资源（缺 CA 或 CA 反应慢） |
| 新 Pod Running 但没接流量 | readiness 未通过（启动慢/探针太严） |
| 扩完很快又缩 | 指标抖动 + 缺稳定窗口 |
| 扩到 maxReplicas 还在报错 | 上限设太小，或指标选错 |
| 扩容后延迟更高 | 冷启动（缓存未预热、连接池未建立） |

**先判断瓶颈在哪一层**：

```
① 应用 CPU 高？→ 扩应用有用
② 应用 CPU 不高但延迟高？→ 查下游（DB、缓存、外部 API）
③ DB 是瓶颈？→ 扩应用只会让 DB 更慢
```

### 冷启动问题

新 Pod 起来后：

```
① JVM/Go 的运行时预热（前 30 秒很慢）
② 连接池为空（每次请求都新建连接）
③ 本地缓存为空（全部穿透到 DB）
```

对策：

```
① 加 startupProbe 给足启动时间
② 预热脚本（启动后先打几个内部请求）
③ 慢启动（slow start）：新 Pod 逐步接流量
   - Istio/Envoy/Nginx 都支持
④ 保持 minReplicas 不要太小（避免"全冷"）
```

### 监控 HPA 本身

```bash
kubectl get hpa -A
# 关注 TARGETS 是否显示 <unknown>
kubectl describe hpa api -n prod      # Events 里有扩容/缩容记录
```

`<unknown>` 说明指标采集失败：

```bash
kubectl top pod -n prod               # metrics-server 是否正常
kubectl get --raw /apis/metrics.k8s.io/v1beta1/nodes
```

### 检查清单

```
□ HPA v2 且配了 behavior（扩快缩慢）
□ 有 minReplicas（不要设 1）
□ 指标选对（Web 用 QPS，CPU 密集用 CPU）
□ 应用有 readinessProbe，且启动时间已知
□ 集群有 CA/Karpenter，节点有缓冲容量
□ 关键服务有 PDB
□ 扩缩容历史可查（describe hpa 或事件）
□ 知道瓶颈在哪一层（不是无脑扩容）
```
