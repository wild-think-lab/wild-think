---
title: 服务网格：Istio 的用处与代价
module: 进阶篇
summary: 服务网格解决什么、sidecar 注入与流量劫持、mTLS 与灰度路由，以及"什么情况下不该上网格"。
minutes: 50
---

### 它到底解决什么

```
① 服务间通信的加密与身份（mTLS）
② 细粒度流量治理（重试/超时/熔断/灰度）
③ 统一可观测（每跳的指标与链路）
④ 策略即代码（谁能调谁）
```

**"为了灰度发布上网格"** → 单靠 Ingress 也能做，先评估收益。

### 架构

```
控制面 istiod（配置分发、证书签发）
数据面 sidecar（envoy）注入到每个 Pod
```

**注入方式**：

```
① sidecar：每 Pod 加一个 envoy 容器（兼容好，资源多）
② ambient：节点级 ztunnel 劫持（资源省，新方案）
```

### 流量劫持原理（要能解释）

```
iptables 规则 → 出站流量转给 envoy:15001 → 按配置转发
```

```bash
istioctl proxy-status
istioctl x describe pod <pod>
```

**"网格装了但没生效"** → 命名空间没开注入（`istio-injection=enabled` 标签）。

### mTLS（网格最实用的部分）

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata: { name: default, namespace: app }
spec:
  mtls: { mode: STRICT }
```

```
STRICT：强制双向证书
PERMISSIVE：允许明文（迁移期）
DISABLE：关闭
```

**效果**：服务身份由证书保证，比共享 token 更难伪造。

### 灰度与流量切分

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: { name: order }
spec:
  hosts: ["order.example.com"]
  http:
    - match: [{ headers: { x-canary: { exact: "1" } } }]
      route: [{ destination: { host: order-canary, port: { number: 80 } } }]
    - route:
        - destination: { host: order-v1, port: { number: 80 } }
          weight: 90
        - destination: { host: order-v2, port: { number: 80 } }
          weight: 10
```

### 故障排查

```bash
istioctl analyze -n app
istioctl proxy-config cluster <pod> --fqdn order.app.svc.cluster.local
istioctl proxy-config listener <pod>
istioctl proxy-config route <pod>
```

**判据**：`proxy-config cluster` 里没有目标服务 → 路由/注册问题。

### 五个"上了网格更麻烦"

**① 资源开销**

```
每 Pod 一个 envoy → 内存与 CPU 上涨（小集群明显）
```

**② 排障链路变长**

```
多一跳代理 → 延迟与日志都多一层
```

**③ 证书轮换问题**

```
istiod 挂了 → 证书续不上 → mTLS 失败
```

**④ 与 CNI/网络策略叠加**

```
NetworkPolicy + 网格劫持 → 规则互相打架
```

**⑤ 只有部分服务在网格内**

```
未注入的服务通信变成"明文直连"，看起来像网格失效
```

### 什么时候不该上

```
① 服务 < 10 个，通信简单
② 团队没有运维网格的能力
③ 主要诉求只是"灰度"，用 Ingress/Argo Rollouts 就够
```

**结论**：先有 mTLS/可观测/治理需求，再上网格。

### 检查清单

```
□ 明确目标（mTLS/治理/可观测）
□ 注入方式选定（sidecar/ambient）
□ 命名空间标签正确
□ 证书轮换与 istiod 高可用
□ 与 NetworkPolicy 的关系已理清
□ 有 proxy-status 与配置检查
□ 每跳延迟有基线
□ 资源开销已评估
□ 有"退出方案"（能摘掉网格）
□ 团队有人能排障
```
