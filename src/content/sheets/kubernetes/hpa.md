---
title: HPA/VPA 速查
summary: HPA 常用命令、指标类型、behavior 防抖参数、VPA 三种模式与"扩不动"的排查顺序。
group: kubernetes
order: 2
tags: [Kubernetes, 弹性, 容量]
---

### 查看

```bash
kubectl get hpa
kubectl describe hpa app-hpa
kubectl get hpa app-hpa -o yaml
kubectl top pods -l app=myapp
```

### describe 里的关键行

```
Current replicas / Desired replicas
Metrics: cpu: 80%/60%
Conditions: AbleToScale / ScalingActive / ScalingLimited
Events: 扩容/缩容记录
```

**`ScalingLimited=True`** → 已到 min/max 边界。

### metrics 类型

```yaml
metrics:
- type: Resource
  resource: {name: cpu, target: {type: Utilization, averageUtilization: 60}}
- type: Pods
  pods: {metric: {name: qps}, target: {type: AverageValue, averageValue: 100}}
- type: Object
  object:
    metric: {name: requests_per_second}
    describedObject: {apiVersion: v1, kind: Service, name: svc}
    target: {type: Value, value: "500"}
```

### behavior（防抖）

```yaml
behavior:
  scaleUp:
    stabilizationWindowSeconds: 30
    policies: [{type: Percent, value: 100, periodSeconds: 15}]
  scaleDown:
    stabilizationWindowSeconds: 300
    policies: [{type: Pods, value: 2, periodSeconds: 60}]
```

### VPA

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
spec:
  updatePolicy: {updateMode: "Off"}
```

```bash
kubectl describe vpa app-vpa | grep -A5 "Container Recommendations"
```

### "扩不动"排查顺序

```
1) kubectl top pod 指标是否真的高
2) describe hpa 看 Metrics 是否有值（<unknown> → 采集失败）
3) Conditions 是否 ScalingLimited
4) maxReplicas / 节点资源（Pending）
5) request 是否设置（利用率依赖 request）
6) metrics-server 是否正常
```

### 判据表

| 现象 | 原因 |
| --- | --- |
| Metrics: `<unknown>` | metrics-server / request 缺失 |
| ScalingLimited=True | 触达 min/max |
| 扩容后 Pod Pending | 节点资源不足 |
| 反复扩缩 | 缺 stabilizationWindow |
| 扩容无效 | 瓶颈不在 CPU（用自定义指标） |

### 坑

```
① 不设 request → HPA 无法计算利用率
② VPA 与 HPA 同指标 → 互相打架
③ 只扩副本不看冷启动 → 高峰已过
④ minReplicas=1 且节点挂 → 瞬间无服务
⑤ 扩容触发太慢 → 用"排队/QPS"提前扩
```
