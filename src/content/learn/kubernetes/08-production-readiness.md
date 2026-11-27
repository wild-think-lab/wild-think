---
title: 第 8 章 · 上生产的最后一公里：资源、HPA、PDB 与发布策略
module: 熟练篇
summary: 资源配额与 LimitRange、HPA 的正确前提、PDB 怎么保证滚动更新不断、蓝绿与金丝雀的落地方式，以及上线前的检查清单。
minutes: 22
---

### 资源：三道闸

| 层级 | 对象 | 作用 |
| --- | --- | --- |
| Pod 级 | `resources.requests/limits` | 调度与运行限制 |
| 命名空间级 | `ResourceQuota` | 限制一个 ns 的总量 |
| 默认值 | `LimitRange` | 没写 resources 时给默认值 |

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: prod-quota
  namespace: prod
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    limits.cpu: "40"
    limits.memory: 80Gi
    pods: "60"
```

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: prod
spec:
  limits:
  - type: Container
    default:        { cpu: 500m, memory: 512Mi }
    defaultRequest: { cpu: 100m, memory: 128Mi }
```

`LimitRange` 的意义：**防止有人漏写 resources 导致 BestEffort Pod 被优先驱逐**。

### HPA 的三个前提

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-api
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: order-api }
  minReplicas: 3
  maxReplicas: 12
  metrics:
  - type: Resource
    resource: { name: cpu, target: { type: Utilization, averageUtilization: 60 } }
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
```

前提：

1. **metrics-server 部署且可用**（`kubectl top pods` 能出数）。
2. **Pod 必须设 requests**，利用率 = 实际 / requests，没 requests 就无法计算。
3. 阈值不是越低越好：设 30% 会频繁扩容，设 90% 又来不及。**60–70% 是常用区间**。

HPA 不扩的三个最常见原因：

- `TARGETS: <unknown>` → metrics-server 挂了。
- 已经在 `maxReplicas`。
- 扩了但没用 → 瓶颈在 DB、下游或单例锁，不在副本数。

### PDB：让滚动更新不"断服务"

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-api
  namespace: prod
spec:
  minAvailable: 2          # 至少保留 2 个可用
  selector:
    matchLabels: { app: order-api }
```

它约束的是**自愿中断**（节点维护、`kubectl drain`、集群升级），不是崩溃。没有 PDB 时，`drain` 会把一台机器上的 3 个副本一次全赶走。

配合注意：`minAvailable` 必须小于 `replicas`，等于的话 `drain` 会永远卡住。

### 三种发布策略

**① 滚动更新（RollingUpdate）**：默认，适用于大多数服务。

```yaml
strategy:
  rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
```

**② 蓝绿**：起一套新的（green），验证通过后切流量。

简单做法是用两个 Deployment + 一个 Service 的 selector 切换：

```bash
kubectl -n prod scale deploy/order-api-green --replicas=3
kubectl -n prod exec tmp -- curl -s http://order-api-green:80/healthz
kubectl -n prod patch svc order-api -p '{"spec":{"selector":{"version":"green"}}}'
```

缺点：要双份资源；回滚是"切回去"，很快。

**③ 金丝雀**：先放 5% 流量，观察指标，再逐步放大。

需要 Ingress Controller 或 Service Mesh 支持按比例分流：

```yaml
# nginx-ingress canary
nginx.ingress.kubernetes.io/canary: "true"
nginx.ingress.kubernetes.io/canary-weight: "10"
```

### 上线前检查清单

```
[ ] resources 都有 requests 与 limits
[ ] readinessProbe 指向真实健康端点
[ ] livenessProbe 不依赖外部服务
[ ] PDB 已配置且 minAvailable < replicas
[ ] HPA 的 min/max 与容量对齐
[ ] 镜像 tag 是不可变版本（不用 latest）
[ ] ConfigMap/Secret 已在目标环境存在
[ ] 有回滚方式（rollout undo 或切 selector）
[ ] 日志与监控能看到新实例
[ ] 优雅退出：应用处理 SIGTERM，preStop 留缓冲
```

### 一个常被忽略的点：滚动更新的"流量一致性"

`maxUnavailable: 0` 只保证"Pod 数量不减"，但新 Pod **就绪瞬间**可能还没预热完（缓存没加载、连接池没建），此时接流量会慢。

解法：readinessProbe 里加"预热完成"的判断，而不是进程起来就返回 200。

```go
var warmed atomic.Bool

mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
	if !warmed.Load() {
		http.Error(w, "warming", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(200)
})
```

### 本章小结

生产可用 = **资源可控（quota/limit）+ 弹性可控（HPA）+ 中断可控（PDB）+ 发布可控（策略与回滚）**。四条都齐了，才算"能上生产"。
