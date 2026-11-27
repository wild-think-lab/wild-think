---
title: Istio mTLS 与服务间认证：从"网格内互信"到"零信任"
description: PERMISSIVE/STRICT 两种模式、证书怎么签发、三种身份（SPIFFE/DNS/自定义），以及多集群的信任域。
date: 2026-11-27
tags: [Istio, mTLS, 安全, 服务网格]
---

### 先说 Istio 的"默认信任"

```
默认：网格内所有工作负载相互信任（不校验对端身份）
→ 任何能进网格的 Pod 都能调任何服务
```

**这是一个很大的假设**。mTLS 就是把"信任"变成"认证"。

### 两种模式

```yaml
# mesh 级别
spec:
  meshConfig:
    defaultConfig:
      holdApplicationUntilProxyStarts: true
```

```yaml
# PeerAuthentication 控制"如何认证入站"
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system     # 全局
spec:
  mtls:
    mode: STRICT
```

**三种模式**：

```
PERMISSIVE：接受明文与 mTLS（迁移期用）
STRICT    ：只接受 mTLS
DISABLE   ：完全关闭该工作负载的 mTLS
```

**迁移路径**：

```
① 全网格 PERMISSIVE（观察哪些流量是明文的）
② 逐个命名空间 STRICT
③ 全网格 STRICT
```

**直接上 STRICT 会断掉所有未配证书的流量**（包括外部来的）。

### 证书怎么签发

**Istio 自带两种方式**：

```
① istiod 内置 CA（自签，用于实验）
② 接入外部 CA（Citadel 已弃用，现在推荐 cert-manager 或 SPIFFE）
```

**生产推荐**：

```
cert-manager 用同一个 CA 给 Istio 的 workload 签证书
（istio-csr 项目：cert-manager + istio-csr）
```

**为什么不用"每个服务各自一张证书"**：

```
Istio 的 sidecar 要拿证书做 mTLS 握手
→ 证书由控制面统一签发与轮转（服务无感知）
```

### 三种身份

**① SPIFFE ID（Istio 默认）**

```
spiffe://cluster.local/ns/<namespace>/sa/<serviceaccount>
```

**② DNS 身份**

```
<service-account>.<namespace>.serviceaccount.identity.linkerd.cluster.local（那是 Linkerd）
Istio 里可用 DNS 形式做授权匹配
```

**③ 自定义**

```yaml
# 从 JWT 或 header 派生身份（需 RequestAuthentication）
```

**授权用 AuthorizationPolicy 匹配身份**：

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-web-to-api
  namespace: prod
spec:
  selector:
    matchLabels: { app: api }
  action: ALLOW
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/prod/sa/web"]
    to:
    - operation:
        methods: ["GET"]
        paths: ["/api/v1/*"]
```

**关键点**：

```
principals 匹配的是"对端证书里的身份"
→ 这意味着"只允许 web 这个 ServiceAccount 调 api 的 GET"
```

**不配 AuthorizationPolicy 时，mTLS 只保证"对端持有有效证书"，不限制"谁能调谁"**。

### mTLS 的完整链路

```
① web Pod 发起请求 → 出站 sidecar
② 出站 sidecar 与 api 的入站 sidecar 做 TLS 握手
③ 双方交换证书（由 istiod 签发）
④ api 的 sidecar 校验证书链 + 提取 SPIFFE 身份
⑤ AuthorizationPolicy 用该身份做决策
⑥ 转发给业务容器
```

**注意"业务容器看不到证书"**：mTLS 在 sidecar 之间完成，业务代码无感知。

### 常见问题一：外部调用方被拒绝

```
现象：STRICT 后，从网格外（如 SLB、其他集群）来的请求 503
原因：外部流量没有 Istio 签发的证书
处理：
① 入口处用 PERMISSIVE（按命名空间/端口区分）
② 或让外部系统接入同一 CA 签发的证书
```

**按端口区分模式**：

```yaml
spec:
  selector:
    matchLabels: { app: api }
  portLevelMtls:
    8080:
      mode: PERMISSIVE
  mtls:
    mode: STRICT
```

**这是"内部 STRICT、外部端口 PERMISSIVE"的标准做法**。

### 常见问题二：证书轮转导致短暂中断

```
istiod 默认证书有效期短（如 24 小时，自动轮转）
如果轮转时 Sidecar 没有平滑切换 → 握手失败
```

**检查**：

```bash
istioctl proxy-config secret <pod> -n <ns>
# 看证书的有效期与剩余时间
```

**处理**：

```
① 不要手动改证书有效期（让 istiod 管）
② 有大量 503 时先查"是否刚发生轮转"
③ 时钟必须准（证书校验依赖时间）
```

### 常见问题三：与 NetworkPolicy 的关系

```
Istio 的 mTLS 是"应用层认证"
K8s NetworkPolicy 是"网络层隔离"
```

**两者互补，不能互相替代**：

```
NetworkPolicy：阻止 Pod 连接不该连的 IP/端口
mTLS          ：即使能连上，也校验"你是谁"
```

**只上 mTLS 不上 NetworkPolicy，攻击面仍然很大**。

### 多集群信任域

```
集群 A 的 istiod 与集群 B 的 istiod 各有自己的 CA
→ A 的服务不信任 B 的证书
```

**方案**：

```
① 共享根 CA（都从同一个根签发）→ 最简单
② 交换信任（各自签发的根互相加入 trust store）
③ SPIFFE 联邦（标准化的跨域信任）
```

**共享根 CA 的代价**：一个集群的 CA 泄露，全盘皆输 → 生产更推荐"分层 CA"（根 + 中间 CA）。

### 性能开销

```
mTLS 每次新建连接要握手（几 ms）
→ 已有连接复用则无额外开销
```

**实测影响**：

```
小请求（< 1KB）场景，mTLS 增加的延迟可感知（约 1–5ms）
大请求场景几乎无感
```

**缓解**：确保 sidecar 间连接复用（Istio 默认有连接池）。

### 一个落地顺序

```
① 全网格 PERMISSIVE，观察 1 周（看有没有明文流量告警）
② 逐个命名空间 STRICT（从内部服务开始）
③ 对入口端口保持 PERMISSIVE
④ 加 AuthorizationPolicy（最小权限）
⑤ 配合 NetworkPolicy
⑥ 监控 503/证书过期
```

**每一步都要能回滚**（改 PeerAuthentication 即可）。

### 检查清单

```
□ 明确默认信任的假设（网格内互信）
□ 迁移从 PERMISSIVE 开始
□ 入口端口单独 PERMISSIVE
□ 有 AuthorizationPolicy（不只靠 mTLS）
□ 配合 NetworkPolicy
□ 证书由统一 CA 签发（不手改有效期）
□ 监控证书轮转与 503
□ 时钟同步（chrony）
□ 多集群有共享根/联邦方案
□ 知道小请求下 mTLS 有毫秒级开销
```
