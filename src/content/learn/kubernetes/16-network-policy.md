---
title: NetworkPolicy 与多租户隔离
module: 进阶篇
summary: 默认拒绝的前提、Pod 选择器与端口规则、DNS 例外、命名空间隔离，五个"策略写了却没生效"的原因。
minutes: 45
---

### 前提：CNI 必须支持

```
Calico / Cilium：支持
Flannel（默认）：不支持 → 策略静默无效
```

```bash
kubectl get pods -n kube-system | grep -E "calico|cilium|flannel"
```

**"策略写了但流量照通"** 首先要确认 CNI。

### 默认拒绝（推荐起点）

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny, namespace: app }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```

**注意**：Egress 全拒绝会连 DNS 都断，要单独放行。

### 放行 DNS

```yaml
  egress:
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
```

**"加了 default-deny 后全部超时"** → 基本是 DNS 没放行。

### 服务间放行

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-from-gateway, namespace: app }
spec:
  podSelector: { matchLabels: { app: order } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ingress-nginx } }
          podSelector: { matchLabels: { app.kubernetes.io/name: ingress-nginx } }
      ports:
        - { protocol: TCP, port: 8080 }
```

**要点**：`namespaceSelector` 与 `podSelector` 在同一个 `from` 项里是"与"关系；分两项是"或"。

### 多租户隔离

```
① 每团队一个 namespace
② 默认拒绝 + 只放行内部通信
③ 禁止跨 ns（除网关/监控）
④ 配合 ResourceQuota 与 RBAC
```

**判据**：租户 A 的 Pod 无法直连租户 B 的 Service。

### 出口限制（防数据外流）

```yaml
  egress:
    - to:
        - ipBlock: { cidr: 10.0.0.0/16 }
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: ["169.254.169.254/32"]   # 禁元数据服务
```

**注意**：ipBlock 不适用于"服务名"，只对 IP 生效。

### 五个"策略没生效"

**① CNI 不支持**

```
策略被忽略（无报错）
```

**② 标签写错**

```
podSelector 匹配不到 Pod
```

**③ 只写 Ingress**

```
出方向完全放开
```

**④ 忘了 kube-system DNS**

```
全断
```

**⑤ 与 Service Mesh 叠加**

```
sidecar 劫持后源 IP 变了 → 策略按 IP 判断失效
```

### 验证方法

```bash
# 从 A Pod 测到 B Service
kubectl exec -n app deploy/client -- nc -zv order 8080
# 观察策略命中（Calico）
calicoctl get networkpolicy -n app -o yaml
```

**"凭感觉以为生效"** → 一定要正反两面测（该通的通、该断的断）。

### 检查清单

```
□ CNI 支持 NetworkPolicy
□ 每个 ns 有 default-deny
□ DNS 已放行
□ 服务间按标签放行（最小端口）
□ 有出口限制（防外流）
□ 与网格/代理的源 IP 关系已理清
□ 有正反两面测试用例
□ 策略有版本管理（Git）
□ 有策略变更评审
□ 有跨 ns 访问审计
```
