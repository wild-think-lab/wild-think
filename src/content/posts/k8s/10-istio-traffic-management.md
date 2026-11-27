---
title: Istio 流量治理：重试、超时、熔断与限流怎么配才不互相打架
description: VirtualService 的四类治理能力、超时链怎么对齐、重试的爆炸风险、熔断阈值与连接池的关系，以及"配了但没生效"的排查。
date: 2026-11-27
tags: [Istio, Service Mesh, 流量治理, Kubernetes]
---

### 四类治理能力

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: { name: order }
spec:
  hosts: [order.example.com]
  http:
  - route:
    - destination: { host: order-svc, port: { number: 8080 } }
      weight: 90
    - destination: { host: order-svc-canary, port: { number: 8080 } }
      weight: 10
    timeout: 3s
    retries:
      attempts: 3
      perTryTimeout: 1s
      retryOn: "5xx,reset,connect-failure"
```

四类能力对应四个字段：

| 能力 | 字段 | 解决什么 |
| --- | --- | --- |
| 路由/灰度 | `route.weight` | 按比例分流 |
| 超时 | `timeout` / `perTryTimeout` | 防止无限等待 |
| 重试 | `retries` | 应对瞬时抖动 |
| 熔断/限流 | `outlierDetection` / EnvoyFilter | 保护下游 |

### 超时链：必须层层递减

```
客户端超时 5s
  └─ 网关（Istio）timeout 3s
       └─ 应用内部 RPC 超时 2s
            └─ 数据库查询超时 1s
```

原则：**外层超时必须大于内层**，否则内层还没结束，外层已经放弃，日志里会出现"上游超时但下游其实成功了"的困惑。

常见错误：

```yaml
timeout: 100ms        # 网关
# 但应用内部默认 500ms，永远等不到结果
```

排查方法：在链路追踪里看 span 的耗时与状态，若大量 span 显示 `cancelled` 且发生在固定时间点，就是超时链不匹配。

### 重试的爆炸风险

```yaml
retries:
  attempts: 3
  perTryTimeout: 1s
```

`attempts: 3` 意味着最多 3 次尝试（含首次）。风险在于**重试会放大下游压力**：

```
下游已经过载 → 超时 → 重试 → 压力 ×3 → 更过载
```

所以：

1. **只对幂等请求重试**（GET、幂等 PUT）。非幂等（下单）重试会造成重复订单。
2. `retryOn` 只选 `connect-failure`、`reset` 这类"没到业务层"的错误，不要把 `5xx` 全开（业务 500 重试通常还是 500）。
3. 配熔断，让"持续失败"的服务停止被重试。

```yaml
retryOn: "connect-failure,reset,retriable-4xx"
```

### 熔断（outlierDetection）

```yaml
trafficPolicy:
  outlierDetection:
    consecutive5xxErrors: 5
    interval: 10s
    baseEjectionTime: 30s
    maxEjectionPercent: 50
```

含义：10 秒内连续 5 个 5xx，就把这个实例"弹出"30 秒，期间不给它流量。

三个参数要一起看：

- `maxEjectionPercent: 50`：**最多弹出一半实例**，否则全弹出等于全站不可用。
- `baseEjectionTime` 与 `interval` 的比例：弹出时间太短（如 5s），实例还没恢复就又接流量。
- 实例数少时（如 2 个），熔断容易变成"全挂"，要慎重。

### 限流

Istio 原生没有"按租户限流"，需要 LocalRateLimit（EnvoyFilter）或外接：

```yaml
# EnvoyFilter 片段（local rate limit）
typedConfig:
  '@type': type.googleapis.com/envoy.extensions.filters.http.local_ratelimit.v3.LocalRateLimit
  statPrefix: http_local_rate_limiter
  tokenBucket:
    maxTokens: 100
    tokensPerFill: 100
    fillInterval: 1s
```

本地限流是"每 Envoy 实例"的，多副本时实际限额是 N 倍。需要全局限额就得用 Redis 之类的集中计数（这又回到"网关该不该做限流"的老问题）。

判断：**保护自身（防打爆）用本地限流；按租户计费/配额用集中限流。**

### "配了但没生效"的排查

```bash
# ① 确认 VirtualService 被正确绑定到 Gateway
istioctl analyze
istioctl proxy-config routes deploy/istiod | grep order

# ② 确认 Envoy 实际配置里有你的规则
istioctl proxy-config clusters <pod>.<ns>
istioctl proxy-config endpoint <pod>.<ns>

# ③ 看请求实际走了哪个子集
istioctl proxy-config log <pod>.<ns> --level debug
```

三个常见原因：

1. **host 不匹配**：`hosts` 写的是域名，但请求用的 IP 或另一个域名。
2. **Gateway 选择器不匹配**：VirtualService 没绑定到实际承载流量的 gateway。
3. **规则顺序**：Istio 按顺序匹配，前面的规则把流量截走了。

### 与 Ingress 的分工

| 层 | 做什么 |
| --- | --- |
| Ingress | 域名接入、TLS、基础路由 |
| VirtualService | 灰度、重试、超时、熔断、流量镜像 |

不建议两者都做灰度（会冲突）。**选一层做治理**，另一层只做接入。

### 一条检查清单

```
□ 超时链层层递减，无"外层小于内层"
□ 重试只对幂等请求，且 retryOn 不含全部 5xx
□ 熔断有 maxEjectionPercent 上限
□ 实例数 < 3 的服务慎用熔断
□ 限流明确了"本地"还是"全局"
□ istioctl analyze 无 warning
□ 用 istioctl proxy-config 验证规则真的进了 Envoy
```
