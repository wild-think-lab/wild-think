---
title: K8s 安全加固：从 RBAC 到运行时
description: 四层加固（准入/工作负载/网络/运行时）、最小权限 RBAC 的写法，以及五个"集群看着安全其实很松"的原因。
date: 2026-05-15
tags: [Kubernetes, 安全, 加固]
---

### 四层

```
① 准入层：谁能创建什么（RBAC + 策略）
② 工作负载层：容器怎么跑（securityContext）
③ 网络层：谁能访问谁（NetworkPolicy）
④ 运行时层：跑起来后怎么防（seccomp/AppArmor/EDR）
```

### ① RBAC：最小权限

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: app
  name: pod-reader
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list"]
```

**五个"RBAC 过宽"的典型**：

```
① 给开发 cluster-admin
② 用 default ServiceAccount 且 automount 开着
③ 给"list secrets"权限（等于拿到全部密钥）
④ CI 用长期 token（cluster-admin）
⑤ 没有按命名空间隔离
```

**"list secrets"** 是最危险的一条（不需要 get 就能读到全部）。

### ② securityContext

```yaml
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    fsGroup: 10001
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: ["ALL"]
```

**要点**：

```
① runAsNonRoot（不要 root）
② drop ALL capabilities
③ readOnlyRootFilesystem（需要写的地方挂 emptyDir）
④ seccomp RuntimeDefault（挡掉大量系统调用）
```

**"readOnlyRootFilesystem 一开就崩"** → 应用往 /tmp 或工作目录写文件，要挂 volume。

### ③ NetworkPolicy

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: default-deny, namespace: app}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```

**然后按需放开**：

```yaml
spec:
  podSelector: {matchLabels: {app: api}}
  ingress:
  - from:
    - podSelector: {matchLabels: {app: gateway}}
    ports: [{port: 8080}]
  egress:
  - to:
    - podSelector: {matchLabels: {app: db}}
    ports: [{port: 5432}]
```

**"默认拒绝 + 白名单"** 是唯一有效的方式（默认全通等于没有）。

**前提**：

```
CNI 必须支持 NetworkPolicy（Calico/Cilium 支持，flannel 默认不支持）
```

**"策略写了不生效"** → 90% 是 CNI 不支持。

### ④ 运行时

```
① 镜像扫描（trivy，CI 里阻断高危）
② 签名校验（cosign + 准入策略）
③ 只允许可信仓库（Kyverno 校验 image registry）
④ 运行时检测（Falco/EDR）
```

### 五个"看着安全其实很松"

**① ServiceAccount token 自动挂载**

```yaml
spec:
  automountServiceAccountToken: false
```

**"每个 Pod 都带一个能访问 API 的 token"** 是横向移动的起点。

**② 没有限制 hostPath / hostNetwork**

```
hostPath 挂 / → 等于宿主机 root
→ 准入策略禁止 hostPath（除少数系统组件）
```

**③ 没有限制 privileged / hostPID**

```
privileged 容器可以直接操作宿主机内核
```

**④ 镜像来源不受限**

```
任意 docker.io 镜像都能跑 → 供应链风险
```

**⑤ 没有审计日志**

```
apiserver 审计关闭 → 出事查不到"谁创建了什么"
```

```yaml
# apiserver
--audit-log-path=/var/log/audit.log
--audit-policy-file=/etc/kubernetes/audit-policy.yaml
```

### 一个"分级"的加固清单

**必做（低成本）**：

```
□ runAsNonRoot + drop ALL
□ automountServiceAccountToken: false
□ NetworkPolicy 默认拒绝
□ 镜像扫描
□ 审计日志开启
□ 不给 list secrets 权限
```

**进阶**：

```
□ readOnlyRootFilesystem
□ seccomp RuntimeDefault
□ 签名校验
□ 准入策略（禁 privileged/hostPath）
□ 运行时检测（Falco）
```

### 检查清单

```
□ 无 cluster-admin 泛滥
□ 按命名空间隔离权限
□ 无 list/get secrets 的宽权限
□ ServiceAccount 按需创建
□ Pod 非 root + drop ALL
□ 无 privileged/hostPath（除系统组件）
□ NetworkPolicy 默认拒绝 + 白名单
□ CNI 支持 NetworkPolicy
□ 镜像扫描 + 可信仓库
□ 审计日志开启
□ 有运行时检测
```
