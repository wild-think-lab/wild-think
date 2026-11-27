---
title: 第 10 章 · 权限与安全：RBAC、ServiceAccount 与最小化
module: 进阶篇
summary: RBAC 四要素、ServiceAccount 与 token、Pod 安全上下文、审计日志，以及五个"权限配了但没管住"的原因。
minutes: 50
---

### RBAC 四要素

```
Role/ClusterRole      能做什么（规则）
RoleBinding/ClusterRoleBinding  谁可以做（绑定）
Subject               用户/组/ServiceAccount
```

**"Role 只在命名空间内生效"**，ClusterRole 才能覆盖全局资源（如 nodes）。

### 一个最小可用 Role

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: app-ops, namespace: app}
rules:
- apiGroups: ["", "apps"]
  resources: ["pods", "deployments", "pods/log"]
  verbs: ["get", "list", "watch", "patch"]
```

```yaml
kind: RoleBinding
metadata: {name: app-ops-bind, namespace: app}
subjects:
- {kind: User, name: "deploy@example.com", apiGroup: rbac.authorization.k8s.io}
roleRef: {kind: Role, name: app-ops, apiGroup: rbac.authorization.k8s.io}
```

**判据**：能 `get/list/watch` 但不需要 `create/delete` 时，就别给。

### ServiceAccount 与 token

```yaml
spec:
  serviceAccountName: app-sa
  automountServiceAccountToken: false   # 不需要访问 API 时关掉
```

**"每个 Pod 都挂着 token"** → 一个 RCE 就能调 apiserver（横向移动的起点）。

### Pod 安全上下文

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: {drop: ["ALL"]}
  seccompProfile: {type: RuntimeDefault}
```

### 审计

```yaml
# audit-policy.yaml（apiserver 启动时指定）
rules:
- level: RequestResponse
  verbs: ["create","update","patch","delete"]
  resources: [{group: "", resources: ["secrets","serviceaccounts"]}]
- level: Metadata
  omitStages: ["RequestReceived"]
```

**"没有审计"** → 出了事不知道谁在什么时候做了什么。

### 五个"权限配了但没管住"

**① cluster-admin 给 CI**

```
一次流水线被投毒 → 全集群失守
```

**② 默认 SA 挂 token**

```
任何 Pod 都能调 API
```

**③ 只限制 API，不限制网络**

```
Pod 出网自由 → 横向移动方便
```

**④ 镜像可来自任意仓库**

```
准入层没白名单/验签
```

**⑤ 审计只记录 Metadata**

```
看不到"改了什么 secret"
```

### 权限审计（每季度）

```bash
kubectl get clusterrolebindings -o wide
kubectl get rolebindings -A
kubectl auth can-i --list --as=system:serviceaccount:app:app-sa
```

**"谁有 cluster-admin"** 应该是个人数很少的清单。

### 本章检查清单

```
□ 按 ns 用 Role，不用 ClusterRole（除非必要）
□ 无长期 cluster-admin 的 CI/应用
□ 不需要 API 的 Pod 关闭 token 挂载
□ 非 root + 只读根 + drop caps
□ 有 PSA/seccomp
□ 有审计日志并集中收集
□ 镜像白名单 + 验签
□ 每季度权限审计
□ 有"敏感操作"告警
□ 有权限变更的评审流程
```
