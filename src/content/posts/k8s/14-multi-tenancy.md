---
title: 多租户 K8s：怎么让两个团队共用一个集群还不互相踩
description: 三种隔离级别、命名空间隔离的四个必配、ResourceQuota 与 LimitRange 的实际效果，以及"多租户"做不到的三件事。
date: 2026-11-27
tags: [Kubernetes, 多租户, 隔离, 配额]
---

### 三种隔离级别

| 级别 | 手段 | 隔离强度 | 成本 |
| --- | --- | --- | --- |
| 弱（命名空间） | Namespace + RBAC + Quota | 逻辑隔离 | 低 |
| 中（节点池） | 命名空间 + 节点污点/亲和 | 资源隔离 | 中 |
| 强（独立集群） | 一租户一集群 | 完全隔离 | 高 |

**判断**：内部团队之间 → 弱或中；对外客户（多租户 SaaS）→ 强（独立集群或虚拟集群如 vCluster）。

### 命名空间隔离的四个必配

**① 创建命名空间与配额**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: team-a
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-a-quota
  namespace: team-a
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    limits.cpu: "40"
    limits.memory: 80Gi
    pods: "100"
    services: "20"
    persistentvolumeclaims: "10"
```

**ResourceQuota 的实际效果**：**超过配额时，新的 Pod 创建会直接被拒绝**（不是慢慢限制）。

**② 默认资源限制（LimitRange）**

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: team-a-limits
  namespace: team-a
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 512Mi
    defaultRequest:
      cpu: 200m
      memory: 256Mi
    max:
      cpu: "4"
      memory: 8Gi
```

**没有 LimitRange 的后果**：某个 Pod 不写 limits → 可能吃掉整个节点。

**③ RBAC：只给本命名空间的权限**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: team-a-dev
  namespace: team-a
rules:
- apiGroups: ["", "apps", "batch"]
  resources: ["pods", "deployments", "jobs", "services", "configmaps"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-a-dev
  namespace: team-a
subjects:
- kind: Group
  name: team-a-devs
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: team-a-dev
  apiGroup: rbac.authorization.k8s.io
```

**关键**：用 `Role`（命名空间级）而不是 `ClusterRole`（集群级）。

**④ NetworkPolicy：默认隔离**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-from-other-ns
  namespace: team-a
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector: {}
    - namespaceSelector:
        matchLabels: { tenant: team-a }
```

给命名空间打标签（需要先给 namespace 加 label）：

```bash
kubectl label namespace team-a tenant=team-a
```

### 中级别隔离：节点池

```yaml
# 给租户节点打污点
kubectl taint nodes node5 node6 tenant=team-a:NoSchedule

# Pod 里加容忍
spec:
  tolerations:
  - key: tenant
    operator: Equal
    value: team-a
    effect: NoSchedule
  nodeSelector:
    tenant: team-a
```

**好处**：一个租户的 Pod 不会影响别人的节点。
**代价**：节点利用率下降（每个租户要预留容量）。

### 多租户做不到的三件事

**① 真正的安全隔离**

```
同一集群内的容器共享内核
→ 容器逃逸（内核漏洞）可跨命名空间
→ 强隔离必须用独立集群或 gVisor/Kata 等沙箱运行时
```

**② 完全的资源公平**

```
ResourceQuota 限制"总量"，不限制"瞬时抢占"
一个租户的 Pod 可能瞬间把节点的 CPU 抢光（如果没设 limits）
```

对策：必须有 LimitRange + 节点预留（`kube-reserved`/`system-reserved`）。

**③ 各租户的 CRD 与 Operator 独立性**

```
两个租户都装同名 CRD → 冲突
同一 Operator 服务多个租户 → 权限与数据隔离复杂
```

现实做法：**CRD 与 Operator 由平台团队统一管理**，租户只用不装。

### 一个实用的落地顺序

```
① 先做命名空间 + 配额 + LimitRange（1 天）
② 加 RBAC（按组授权，不按人）
③ 加 NetworkPolicy 默认隔离
④ 关键租户移到独立节点池
⑤ 对外的租户 → 独立集群
```

### 配额设置的坑

```
❌ 配额设得太小 → 业务正常扩容被拒，报警不断
❌ 配额等于节点容量 → 一个租户能把整节点占满
✅ 配额 = 业务峰值 × 1.5，且节点总配额 < 节点容量 × 0.9
```

**建议留 10% 给系统组件**（kubelet、CNI、监控）。

### 检查清单

```
□ 每个租户独立命名空间
□ 有 ResourceQuota（requests + limits + 对象数量）
□ 有 LimitRange（默认值 + 上限）
□ RBAC 用 Role（命名空间级）
□ NetworkPolicy 默认拒绝跨租户
□ 对外租户用独立集群
□ CRD/Operator 由平台统一管理
□ 配额 = 峰值 × 1.5，总配额留 10% 余量
□ 节点有 kube-reserved/system-reserved
```
