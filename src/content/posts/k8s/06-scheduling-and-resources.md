---
title: K8s 调度与资源：requests、limits 与 QoS 的真实行为
description: 调度器到底看哪些字段、requests/limits 各自作用于什么、QoS 三档与驱逐顺序、亲和与污点怎么用、HPA 为什么"不扩容"。
date: 2026-11-27
tags: [Kubernetes, 调度, 资源管理, QoS, 排障]
---

### 调度器只看 requests

一个 Pod 能不能放到某节点，取决于这张表：

- 节点的 `allocatable`（capacity 减去系统预留）
- 该节点上所有 Pod 的 **requests 总和**
- 加上新 Pod 的 requests 是否还放得下

**limits 完全不参与调度决策**。这意味着：

```yaml
resources:
  requests:
    cpu: 100m       # 调度时按 100m 算
    memory: 128Mi
  limits:
    cpu: 2          # 调度器不管这 2 核
    memory: 4Gi
```

一个节点能塞下 80 个这样的 Pod（按 CPU requests），但它们同时跑满时，CPU 会严重超卖、互相抢。**超卖不是错，只要你能接受争抢。**

### requests 与 limits 各自作用在哪

| | requests | limits |
| --- | --- | --- |
| 调度 | 参与 | 不参与 |
| CPU | 保证的权重（cpu.shares） | 上限（cfs quota），超了被限流节流 |
| 内存 | 几乎无实际作用 | **超了直接 OOMKill** |
| 驱逐 | 无 | 用于计算 Pod 的 QoS 等级 |

CPU 是"压缩型"资源：超 limit 只是变慢。内存是"不可压缩"资源：超 limit 就杀进程。这也是为什么**内存 limit 设太小是 K8s 最常见的线上事故**——Java 应用没设 `-XX:MaxRAMPercentage`，堆按宿主机算，容器一超就被 OOMKill，日志里什么都没有。

### QoS 三档与驱逐顺序

Kubernetes 按 requests/limits 的组合自动分级：

1. **Guaranteed**：每个容器都设了 requests 且等于 limits（CPU 与内存都要）。最不容易被驱逐。
2. **Burstable**：至少设了 requests，但 requests < limits。中间档。
3. **BestEffort**：什么都没设。节点压力大时第一个被杀。

节点内存不足时的驱逐顺序：BestEffort → Burstable（按"实际用量超出 requests 的程度"排序）→ Guaranteed（原则上不动）。

所以最省事的做法是：**所有生产工作负载都设 requests，关键服务设 Guaranteed 或至少 requests≈limits**。

### 亲和与反亲和：把 Pod 放到"该去的地方"

```yaml
# 硬约束：必须落在带 ssd 标签的节点
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: disktype
          operator: In
          values: ["ssd"]

# 软约束：尽量和同 app 的 Pod 在一起（减少跨节点流量）
podAffinity:
  preferredDuringSchedulingIgnoredDuringExecution:
  - weight: 80
    podAffinityTerm:
      labelSelector:
        matchLabels: { app: cache }
      topologyKey: kubernetes.io/hostname
```

反亲和用来做"打散"，比如同一个服务的 3 个副本不要落在同一台机器上：

```yaml
podAntiAffinity:
  requiredDuringSchedulingIgnoredDuringExecution:
  - labelSelector:
      matchLabels: { app: api }
    topologyKey: kubernetes.io/hostname
```

注意 `topologyKey` 选 `hostname` 是"按机器打散"，选 `zone` 是"按可用区打散"。**required 用多了会导致 Pod 一直 Pending**，优先用 preferred。

### 污点与容忍：专用节点

给 GPU 节点打污点，只有能容忍的 Pod 才上去：

```bash
kubectl taint nodes gpu-01 dedicated=gpu:NoSchedule

# Pod 侧
tolerations:
- key: dedicated
  operator: Equal
  value: gpu
  effect: NoSchedule
```

`NoSchedule` 只影响新调度，`NoExecute` 会把已有 Pod 赶走。做节点维护时用 `NoExecute` 更彻底。

### HPA 为什么"不扩容"

`kubectl get hpa` 显示 `TARGETS: <unknown>/50%` 或一直不动，按这个顺序查：

```bash
kubectl describe hpa api-hpa
kubectl top pods
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/pods" | head -c 200
```

1. **metrics-server 没起或不通**：`<unknown>` 基本都是这个。HPA 靠 metrics-server 拿数据，它挂了 HPA 就瞎了。
2. **requests 没设**：HPA 的利用率 = 实际用量 / requests。没设 requests 时百分比无意义，HPA 不会扩。
3. **已经在 maxReplicas**：看 `kubectl get hpa -o yaml` 里的 `maxReplicas`。
4. **扩容了但没用**：新 Pod 也慢，说明瓶颈不在副本数（在 DB 连接、下游限流、单例锁）。
5. **缩容抖动**：`behavior.scaleDown.stabilizationWindowSeconds` 太短会来回扩缩，设 300s 以上。

```yaml
behavior:
  scaleUp:
    stabilizationWindowSeconds: 60
    policies: [{ type: Percent, value: 100, periodSeconds: 60 }]
  scaleDown:
    stabilizationWindowSeconds: 300
```

### 常见"资源看着够但不调度"的情况

- **节点 Allocatable 比 Capacity 小很多**：`kubeReserved` + `systemReserved` + `evictionHard` 一起吃掉了 10–20%，看 `kubectl describe node` 的 Allocatable。
- **Pod 数量上限**：kubelet 的 `--max-pods`（默认 110）到了，CPU 还剩一堆也放不进。
- **端口冲突**：hostPort 被占用，调度器不考虑这个，直接调度失败重试。
- **PVC 拓扑限制**：本地盘 PV 绑定了节点，Pod 只能去那台。
- **大页/设备插件资源**：`nvidia.com/gpu: 1` 本质是扩展资源，数量不够就是 Pending。

排查 Pending 的标准三连：

```bash
kubectl get pod -o wide
kubectl describe pod <name>     # Events 里会写具体原因
kubectl get events --sort-by=.lastTimestamp | tail -30
```

### 一句话总结

调度只看 requests，运行看 limits。**requests 决定"能不能上去"，limits 决定"会不会被杀"**——两者都设，且内存 limit 要按应用真实上限 + 余量来定。
