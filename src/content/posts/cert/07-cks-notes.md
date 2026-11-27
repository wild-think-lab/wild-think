---
title: CKS 备考笔记：Kubernetes 安全该会的那些事
description: CKS 考什么、六个必考方向的实操命令、集群加固清单、以及从 CKA 到 CKS 的心态变化。
date: 2026-11-27
tags: [认证, CKS, Kubernetes, 安全]
---

### CKS 考什么

```
CKS = Certified Kubernetes Security Specialist
前提：必须先有 CKA
时长：2 小时，实操，需 67% 及格
```

**考试重点是"安全加固 + 检测 + 应急"**，不是"搭集群"。

### 六个必考方向

**① 集群组件加固**

```
kube-apiserver：
  --anonymous-auth=false
  --authorization-mode=Node,RBAC
  --enable-admission-plugins=NodeRestriction
  --audit-log-path=/var/log/audit.log
  --audit-policy-file=/etc/kubernetes/audit-policy.yaml

kubelet：
  --anonymous-auth=false
  --authorization-mode=Webhook
  --read-only-port=0
  --protect-kernel-defaults=true
```

**审计策略**（考试常考）：

```yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
- level: Metadata
  resources:
  - group: ""
    resources: ["secrets", "configmaps"]
- level: Request
  verbs: ["create", "update", "patch", "delete"]
  resources:
  - group: ""
    resources: ["pods"]
- level: None
  users: ["system:kube-proxy"]
  verbs: ["watch"]
```

**`level: None`** 用于排除噪声（如 kube-proxy 的 watch）。

**② RBAC 与 ServiceAccount**

```bash
# 创建 SA
kubectl create sa app-sa -n prod

# 给它最小权限（只读 pods）
kubectl create role pod-reader --verb=get,list,watch --resource=pods -n prod
kubectl create rolebinding app-sa-read --role=pod-reader --serviceaccount=prod:app-sa -n prod

# 检查谁能做什么
kubectl auth can-i list pods --as=system:serviceaccount:prod:app-sa -n prod
```

**高频考点**：`kubectl auth can-i --as=...` 用来验证权限。

**③ 网络策略（NetworkPolicy）**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend-to-backend
  namespace: prod
spec:
  podSelector:
    matchLabels: { app: backend }
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector:
        matchLabels: { app: frontend }
    ports:
    - protocol: TCP
      port: 8080
```

**关键认知**：

```
① NetworkPolicy 需要 CNI 支持（Calico/Cilium 支持，flannel 不支持）
② 一旦有策略选中某 Pod，该 Pod 的 ingress 默认变为"拒绝"
③ 策略是"允许列表"语义，不是"拒绝列表"
```

**④ 容器运行时安全**

```
- 禁止 privileged
- 禁止 hostPID/hostIPC/hostNetwork
- 只读根文件系统 readOnlyRootFilesystem: true
- 非 root 运行 runAsNonRoot: true
- 去掉 capabilities（drop ALL，只加需要的）
```

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
    add: ["NET_BIND_SERVICE"]
  seccompProfile:
    type: RuntimeDefault
```

**这是 CKS 里最高频的 YAML 片段**，必须背熟。

**⑤ 准入控制（Admission）**

```
内置：NamespaceLifecycle、LimitRanger、ServiceAccount、NodeRestriction
动态：OPA Gatekeeper / Kyverno（考试可能要求用其中之一）
```

Kyverno 例子（禁止 latest tag）：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-latest-tag
spec:
  validationFailureAction: Enforce
  rules:
  - name: require-image-tag
    match:
      resources:
        kinds: [Pod]
    validate:
      message: "Using 'latest' tag is not allowed."
      pattern:
        spec:
          containers:
          - image: "!*:latest"
```

**⑥ 供应链与镜像扫描**

```bash
# 用 trivy 扫镜像
trivy image --severity HIGH,CRITICAL nginx:1.25

# 用 cosign 验签
cosign verify --key cosign.pub registry.example.com/app:v1
```

考试会给一个"有漏洞的镜像"，要求你"找出来并换掉"。

### 应急排查（考试里的"事故题"）

**症状：一个 Pod 疑似被入侵，怎么查**

```bash
# 1. 看 Pod 详情与镜像
kubectl get pod suspicious -o yaml | grep -E "image|securityContext"

# 2. 看进程
kubectl exec suspicious -- ps aux

# 3. 看网络连接
kubectl exec suspicious -- netstat -tulpn
# （可能没装 netstat → 用 /proc 或从 sidecar 看）

# 4. 看容器内文件是否有篡改
kubectl exec suspicious -- ls -la /tmp /dev/shm

# 5. 看审计日志里这个 Pod 做了什么
grep suspicious /var/log/kubernetes/audit.log

# 6. 隔离：先打上 NetworkPolicy（拒绝全部出口）
# 7. 取证：把容器文件系统导出（不要在容器内操作）
docker export / crictl export
```

**核心思路**：**先隔离再取证**，不要在可能被控的环境里跑命令（攻击者可能改了 ps/netstat）。

### 从 CKA 到 CKS 的三个心态变化

```
① CKA 求"跑起来" → CKS 求"跑得安全"
② CKA 里 root 是默认 → CKS 里 root 是错误答案
③ CKA 里 NetworkPolicy 是可选 → CKS 里是默认要加
```

**考试里最容易丢分的**：写了 `runAsUser: 1000` 但没写 `runAsNonRoot: true`（后者才真正阻止以 root 跑）。

### 练习环境

```
① 用 kubeadm 起一个集群，手动加固 apiserver/kubelet
② 装 Calico，练 NetworkPolicy（用 `kubectl run` 起测试 Pod）
③ 装 Kyverno，写两条策略（禁止 latest、要求 resources）
④ 用 trivy 扫常用镜像，看报告结构
⑤ 用 `kubectl auth can-i` 验证 RBAC
```

**建议至少练 2 遍"从零加固"**，因为考试时间紧（2 小时 15–20 题）。

### 检查清单

```
□ apiserver 关了匿名认证 + 开了 NodeRestriction
□ kubelet 关了匿名认证 + read-only-port=0
□ 有审计策略（关键资源 Metadata，写操作 Request）
□ RBAC 最小权限（用 can-i 验证过）
□ NetworkPolicy 默认拒绝 + 白名单
□ Pod securityContext：非 root + 只读根 + drop ALL
□ 有准入策略（禁 latest / 要求 resources）
□ 会扫镜像（trivy）与验签（cosign）
□ 应急流程：先隔离再取证
□ 从零加固练过至少 2 遍
```
