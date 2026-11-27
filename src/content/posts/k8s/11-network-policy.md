---
title: NetworkPolicy 与 CNI：K8s 网络隔离到底怎么落地
description: 默认全通的风险、NetworkPolicy 的四类规则写法、常见"写了不生效"的原因、CNI 的支持差异，以及分阶段落地的顺序。
date: 2024-05-08
tags: [Kubernetes, NetworkPolicy, CNI, 安全]
---

### 默认状态：全通

K8s 默认**没有任何网络隔离**：任意 Pod 可以访问任意 Pod、任意端口。

这意味着：

- 一个被拿下的前端 Pod，可以直接扫内网的数据库。
- 开发环境的 Pod 能访问生产（如果同集群）。

NetworkPolicy 是唯一的解决方式。

### 四类规则

**① 默认拒绝所有入向**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-ingress, namespace: prod }
spec:
  podSelector: {}
  policyTypes: [Ingress]
```

**② 只允许来自某服务的流量**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: api-allow-gateway, namespace: prod }
spec:
  podSelector:
    matchLabels: { app: api }
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector: { matchLabels: { app: gateway } }
    ports:
    - protocol: TCP
      port: 8080
```

**③ 允许来自某命名空间**

```yaml
  ingress:
  - from:
    - namespaceSelector: { matchLabels: { team: platform } }
```

**④ 限制出向（更彻底）**

```yaml
  policyTypes: [Ingress, Egress]
  egress:
  - to:
    - podSelector: { matchLabels: { app: db } }
    ports: [{ protocol: TCP, port: 3306 }]
  - to:                      # 允许 DNS
    - namespaceSelector: {}
      podSelector: { matchLabels: { k8s-app: kube-dns } }
    ports: [{ protocol: UDP, port: 53 }]
```

**出向规则必须放通 DNS**，否则域名解析全部失败——这是最常见的"加了策略后全挂"原因。

### 五个"写了不生效"的原因

**① CNI 不支持**

| CNI | NetworkPolicy 支持 |
| --- | --- |
| Calico | 完整 |
| Cilium | 完整（eBPF 实现，性能好） |
| Flannel | **默认不支持**（需要配合 Calico 或使用 flannel 的 network policy 分支） |
| Antrea | 支持 |

排查：

```bash
kubectl -n kube-system get pod | grep -E 'calico|cilium|antrea'
```

如果只有 flannel，你的策略是"写了但没执行者"。

**② 命名空间不对**

NetworkPolicy 是 namespace 级的。策略写在 `prod`，但 Pod 在 `prod-api`。

**③ podSelector 是"且"关系**

```yaml
podSelector:
  matchLabels: { app: api, tier: backend }
```

要求两个标签**同时**满足。只写一个标签而 Pod 有两个，就不匹配。

**④ 出向默认允许（未被限制）**

只加 Ingress 规则时，出向仍然全通。要限制横向移动，必须同时配 Egress。

**⑤ 策略叠加是"并集"**

多条 Ingress 规则之间是 OR 关系。加一条宽松规则，等于把所有限制废掉。

**检查方式**：

```bash
kubectl get networkpolicy -n prod
kubectl describe networkpolicy api-allow-gateway -n prod
```

### 验证隔离是否真的生效

```bash
# 从 gateway Pod 访问 api（应成功）
kubectl exec -n prod deploy/gateway -- curl -s api:8080/health

# 从其他 Pod 访问 api（应失败）
kubectl exec -n prod deploy/other -- curl -m 2 -s api:8080/health
# 期望：超时

# 从 api 访问外网（如果没配 Egress 放通，应失败）
kubectl exec -n prod deploy/api -- curl -m 2 -s https://example.com
```

**用超时而不是"拒绝"判断**：NetworkPolicy 通常表现为丢包（超时），而不是 connection refused。

### 分阶段落地

不要一次全拒绝，会立刻全站瘫痪。

```
阶段 1：只做"默认拒绝入向" + 逐个服务放通（预发先跑）
阶段 2：生产灰度一个 namespace，观察 1 周
阶段 3：全量 Ingress 策略
阶段 4：加 Egress 策略（先放通 DNS 与必要外网）
阶段 5：正则化——把策略纳入 Git，CI 校验（每个 Deployment 必须有对应策略）
```

每阶段都要有"回滚开关"：删掉策略即恢复全通。

### 编写时的模板化

给每个服务固定一套模板：

```yaml
# 每个服务三份策略：
# 1) 允许来自 ingress-controller
# 2) 允许来自 api-gateway / 同团队调用方
# 3) 允许出向 DNS + 自己的依赖
```

用 Helm/Kustomize 生成，避免手写漏项。

### 与 Service Mesh 的分工

| | NetworkPolicy | Istio AuthorizationPolicy |
| --- | --- | --- |
| 层 | L3/L4（IP/端口） | L7（路径、方法、JWT） |
| 粒度 | Pod/命名空间 | 请求级 |
| 场景 | 隔离网段、限制横向 | 服务间鉴权、按 API 授权 |

两者互补：NetworkPolicy 管"能不能连到"，Istio 管"能不能调用这个接口"。

### 一个真实的收敛案例

某集群被扫描后做了隔离：

```
改造前：任意 Pod 可访问 3306（数据库）
改造后：
- 只有 order-service / user-service 能访问 db:3306
- 只有 ingress-controller 能访问各服务的 8080
- 所有 Pod 出向只允许 DNS + 明确的外部依赖
```

收益：即使某个前端服务被拿下，也拿不到数据库。

代价：新增服务必须同时提交 NetworkPolicy，否则 CI 报错。这个"强制"是长期有效的关键。

### 检查清单

```
□ CNI 确认支持（Calico/Cilium/Antrea）
□ 每个 namespace 有 default-deny
□ 每个服务有明确的 ingress 放通规则
□ Egress 规则放通了 DNS
□ 用 curl + 超时验证过隔离生效
□ 策略在 Git 里，CI 校验"每个 Deployment 都有策略"
```
