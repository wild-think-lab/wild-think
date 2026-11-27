---
title: 第 6 章：安全边界与审计
module: 熟练篇
summary: 四层边界（API/Pod/网络/供应链）、RBAC 最小化的写法、审计日志、以及五个"配了但还是被绕过"的原因。
minutes: 50
---

### 四层边界

```
① API 访问：谁能调 apiserver（RBAC + 认证）
② Pod 能力：能做什么（securityContext / PSA / admission）
③ 网络：能和谁通信（NetworkPolicy）
④ 供应链：镜像从哪来、有没有被改（签名 + 准入）
```

**"只做 RBAC"** 等于只锁了门没管钥匙落在谁手上。

### RBAC 最小化的写法

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: app-reader, namespace: app}
rules:
- apiGroups: [""]
  resources: ["pods","pods/log"]
  verbs: ["get","list","watch"]
```

```yaml
kind: RoleBinding
metadata: {name: app-reader-bind, namespace: app}
subjects:
- {kind: ServiceAccount, name: ci, namespace: app}
roleRef: {kind: Role, name: app-reader, apiGroup: rbac.authorization.k8s.io}
```

**"cluster-admin 满天飞"** 是最常见的坏实践。

**常见过度授权**：

```
① 给 CI 用 cluster-admin（应该是 ns 级 + 限定资源）
② 给开发者 list secrets
③ 默认 SA 自动挂载（不该挂就别挂）
```

```yaml
automountServiceAccountToken: false
```

### Pod 能力收紧

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: {drop: ["ALL"]}
  seccompProfile: {type: RuntimeDefault}
```

**"readOnlyRootFilesystem"** 能挡掉大量"落地工具"的利用。

### PSA（Pod Security Admission）

```bash
kubectl label ns app pod-security.kubernetes.io/enforce=restricted
kubectl label ns app pod-security.kubernetes.io/warn=restricted
```

```
privileged / baseline / restricted 三档
先 warn 观察，再 enforce
```

### NetworkPolicy 默认拒绝

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: default-deny, namespace: app}
spec:
  podSelector: {}
  policyTypes: ["Ingress","Egress"]
```

再按需放行：

```yaml
spec:
  podSelector: {matchLabels: {app: api}}
  ingress:
  - from:
    - namespaceSelector: {matchLabels: {name: ingress}}
    ports: [{port: 8080}]
  egress:
  - to: [{namespaceSelector: {matchLabels: {name: dns}}}]
```

**"只 deny ingress"** 出网仍然自由（横向移动更方便）。

### 审计日志

```yaml
# kube-apiserver 启动参数
--audit-policy-file=/etc/kubernetes/audit-policy.yaml
--audit-log-path=/var/log/kubernetes/audit.log
--audit-log-maxage=30
```

```yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
- level: RequestResponse
  verbs: ["create","update","patch","delete"]
  resources:
  - group: ""        # secrets 等
    resources: ["secrets","serviceaccounts"]
- level: Metadata
  omitStages: ["RequestReceived"]
```

**"审计只记 Metadata"** 对敏感资源不够（要看请求体）。

### 五个"配了但还是被绕过"

```
① 默认 SA 还挂着 token（Pod 里有凭据）
② 有 cluster-admin 的 CI（一次泄漏全失守）
③ NetworkPolicy 由不支持的 CNI 实现（策略无效）
④ 镜像仓库白名单在 kubelet 层，但节点被改（绕过）
⑤ 只有审计没有告警（没人看日志）
```

### 一个"够用"的安全基线

```
① 所有工作负载非 root + 只读根
② 默认 SA 不挂 token
③ 每 ns 有 Role（不用 ClusterRole 除非必要）
④ 默认拒绝 NetworkPolicy
⑤ 镜像来自白名单仓库 + 验签
⑥ 审计日志集中收集 + 关键操作告警
⑦ PSA 在 warn 观察后提升为 enforce
```

### 本章检查清单

```
□ RBAC 按 ns 最小化
□ 无长期 cluster-admin 的 CI
□ 默认 SA 不自动挂 token
□ 容器非 root、只读根、drop ALL caps
□ PSA 已启用（enforce）
□ NetworkPolicy 默认拒绝（入+出）
□ 镜像白名单 + 验签
□ 审计日志开启且集中
□ 有"敏感操作"告警
□ 定期做权限审计（谁有 cluster-admin）
```
