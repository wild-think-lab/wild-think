---
title: K8s 自动扩缩容：HPA、VPA 与"扩容了但没用"
description: 指标怎么选、扩容为什么会滞后、VPA 与 HPA 的冲突、以及五个"扩了还是慢"的真实原因。
date: 2026-11-27
tags: [Kubernetes, HPA, 容量]
---

### 三种"扩缩容"

```
HPA（Horizontal Pod Autoscaler）：加/减 Pod 副本数
VPA（Vertical Pod Autoscaler）  ：调单个 Pod 的 CPU/内存 request
Cluster Autoscaler              ：加/减节点
```

**顺序很重要**：先 HPA 扩副本，仍不够再加节点。

### HPA 的基本结构

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
```

**`behavior` 是"为什么扩容会抖"的答案**：

```
scaleUp.stabilizationWindowSeconds: 0 → 想扩立刻扩
scaleDown.stabilizationWindowSeconds: 300 → 想缩要观察 5 分钟（防抖）
```

**默认行为是"快速扩、缓慢缩"**，这个方向是对的。

### 指标怎么选（关键）

```yaml
# 只用 CPU
metrics:
- type: Resource
  resource: { name: cpu, target: { averageUtilization: 70 } }

# CPU + 内存（取"需要最多副本"的那个）
metrics:
- type: Resource
  resource: { name: cpu, target: { averageUtilization: 70 } }
- type: Resource
  resource: { name: memory, target: { averageUtilization: 80 } }

# 自定义指标（推荐：用业务指标）
metrics:
- type: Pods
  pods:
    metric: { name: http_requests_per_second }
    target: { type: AverageValue, averageValue: 100 }
```

**为什么 CPU 指标不好用**：

```
① CPU 使用率对"IO 密集"服务没有意义（服务在等数据库，CPU 很低）
② 突发时 CPU 上去了，但真正瓶颈在别处
③ JVM 预热期 CPU 高，会误触发扩容
```

**用"业务指标"更准**：

```
队列长度 / 待处理请求数 / P99 延迟 / 每秒请求
→ 这些直接反映"用户感受"
```

### 扩容滞后的真相

```
HPA 每 15s 检查一次（默认）
+ 决策 + 创建 Pod + 调度 + 镜像拉取 + 启动 + 就绪探针
= 从"需要扩容"到"真正能扛"通常 30–120 秒
```

**所以**：

```
① 秒杀/突发场景，HPA 根本来不及（要预置容量）
② 扩容期间部分请求会排队/超时（要配合理的超时与降级）
```

**"用 HPA 应对秒杀"是个误区**。

### VPA 的定位与冲突

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-vpa
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: api
  updatePolicy:
    updateMode: "Off"     # Off / Initial / Auto
```

**三种模式**：

```
Off    ：只给建议，不改（推荐先观察）
Initial：只在创建时设一次
Auto   ：持续调整（会重启 Pod！）
```

**VPA 最大的问题**：**调 request 需要重建 Pod**（K8s 不支持原地改 request）。

**所以**：

```
① 生产上普遍用 Off 模式收集建议，人工采纳
② Auto 模式会导致 Pod 频繁重启（有状态服务绝对不能用）
```

**HPA + VPA 同时基于 CPU 会冲突**（互相抵消）：

```
规则：同一工作负载，VPA 和 HPA 不要都基于 CPU/内存
可以：HPA 按业务指标扩副本，VPA 按 Off 模式给资源建议
```

### Cluster Autoscaler

```
触发条件：有 Pod 因"资源不足"无法调度（Pending）
动作：向云厂商申请新节点
```

**关键参数**：

```
--scale-down-delay-after-add=10m     # 加完后 10 分钟才允许缩
--scale-down-unneeded-time=10m
--node-group-auto-discovery=...
```

**"扩容了但节点没加"的常见原因**：

```
① 云账号配额/权限
② 节点组的 min/max 设置
③ 节点模板镜像有问题（新节点起不来）
④ 有 taint 导致新节点不可调度
```

### 五个"扩了还是慢"的真实原因

**① 瓶颈在数据库**

```
Pod 从 2 扩到 20 → 数据库连接数暴涨 → 数据库被打挂
```

**检查**：扩容前先算"每 Pod 的连接数 × 最大副本数 < 数据库上限"。

**② 瓶颈在共享资源**

```
所有 Pod 抢同一个 Redis / 同一个锁 / 同一个下游 API 的配额
→ 加 Pod 只是让排队更长
```

**③ 就绪探针配错**

```
readinessProbe 太宽松 → 新 Pod 还没准备好就接流量 → 报错
readinessProbe 太严格 → 新 Pod 迟迟不 Ready → 扩容无效
```

**④ request 设置不合理**

```
CPU request 设 100m，实际用 800m
→ 节点超卖 → 所有 Pod 都慢
```

**⑤ 没有"最小副本"兜底**

```
minReplicas: 1 → 缩容时可能只剩 1 个 → 单点
```

**建议 `minReplicas ≥ 2`（或多可用区各 1）**。

### 一个"稳妥"的 HPA 模板

```yaml
spec:
  minReplicas: 3
  maxReplicas: 30
  metrics:
  - type: Pods
    pods:
      metric: { name: http_inflight_requests }
      target: { type: AverageValue, averageValue: 50 }
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
      - type: Pods
        value: 4
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 600
      policies:
      - type: Percent
        value: 25
        periodSeconds: 60
```

**设计意图**：

```
① 按"并发请求数"扩（直接反映压力）
② 每分钟最多加 4 个（避免瞬间打爆下游）
③ 缩容要观察 10 分钟（防抖）
④ 最小 3 个（留冗余）
```

### 观察与调试

```bash
kubectl get hpa -w                 # 实时看副本变化
kubectl describe hpa api           # 看最近决策原因
kubectl top pods                   # 实际用量
```

**`describe` 里的 Events 很重要**：

```
"New size: 5; reason: cpu resource utilization above target"
"Failed to get pods metric: ..."   ← 指标拿不到，HPA 会卡住
```

**自定义指标要先确认 adapter 正常**：

```bash
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1 | jq
```

### 检查清单

```
□ HPA 用业务指标（不只是 CPU）
□ minReplicas ≥ 2（避免单点）
□ scaleUp 有速率上限（防打爆下游）
□ scaleDown 有稳定窗口（防抖）
□ 扩容前评估下游容量（数据库/Redis）
□ 就绪探针准确（能真实反映"可用"）
□ request 接近实际用量（避免超卖）
□ VPA 用 Off 模式先观察
□ 不用 VPA+HPA 同时基于 CPU
□ 知道 HPA 有 30–120s 滞后（突发靠预置容量）
□ 自定义指标 adapter 正常
```
