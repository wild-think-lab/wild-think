---
title: Istio 速查
summary: istioctl 常用命令、流量路由、mTLS 排查、以及"问题出在哪一层"的判断顺序。
group: service
order: 1
tags: [Istio, 服务网格]
---

### 安装与检查

```bash
istioctl install --set profile=default -y
istioctl verify-install
istioctl analyze -n app
kubectl get pods -n istio-system
```

### 注入状态

```bash
istioctl proxy-status
kubectl get pod -l app=x -o jsonpath='{.items[*].spec.containers[*].name}'
```

**没有侧车容器** → 命名空间未开启注入或 Pod 没有 `sidecar.istio.io/inject: "true"`。

### 配置诊断

```bash
istioctl proxy-config cluster  <pod>.<ns>
istioctl proxy-config listener <pod>.<ns>
istioctl proxy-config route    <pod>.<ns>
istioctl proxy-config endpoint <pod>.<ns>
```

**排查顺序**：

```
listener（有没有监听） → route（匹配到哪条规则） → cluster（后端是谁） → endpoint（后端有几个健康实例）
```

### 虚拟服务与目标规则

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: app}
spec:
  hosts: [app.example.com]
  gateways: [mesh]
  http:
  - match: [{uri: {prefix: /api}}]
    route:
    - destination: {host: app, port: {number: 8080}}
    timeout: 30s
    retries: {attempts: 3, perTryTimeout: 5s}
```

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata: {name: app}
spec:
  host: app
  trafficPolicy:
    loadBalancer: {simple: LEAST_REQUEST}
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 5m
```

### 灰度（按权重）

```yaml
  http:
  - route:
    - destination: {host: app, subset: v1}
      weight: 90
    - destination: {host: app, subset: v2}
      weight: 10
```

**subset 需要在 DestinationRule 里定义 `subsets`（按 version 标签）**。

### mTLS 排查

```bash
istioctl authn tls-check <pod>.<ns> <host>
```

**输出看**：

```
STATUS        ：OK / CONFLICT
SERVER        ：istio-mtls / none
CLIENT        ：istio-mtls / none
```

**CONFLICT** = 一端要求 mTLS 另一端没开（PeerAuthentication 不一致）。

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata: {name: default, namespace: app}
spec:
  mtls: {mode: STRICT}    # STRICT / PERMISSIVE / DISABLE
```

### 常用 CR

| 资源 | 作用 |
| --- | --- |
| VirtualService | 路由/重试/超时/灰度 |
| DestinationRule | 负载均衡/熔断/子集 |
| Gateway | 入口（新版 API） |
| PeerAuthentication | mTLS 模式 |
| RequestAuthentication | JWT 校验 |
| AuthorizationPolicy | 授权（L4/L7） |
| Sidecar | 侧车资源限制 |

### 常见问题

| 现象 | 原因 |
| --- | --- |
| 503 UF | 无可用后端（endpoint 为空/健康检查失败） |
| 503 NR | 路由未匹配（host/port 不对） |
| 504 超时 | timeout 配置过小或后端真慢 |
| 连接重置 | mTLS 不一致 / 协议探测失败 |
| 延迟突增 | 侧车 CPU 不足（要设 requests） |

### 性能注意

```
① 侧车要设 CPU requests（否则被限流）
② 大流量下考虑 ambient（无侧车模式）
③ 不要给每个服务都开全文流量捕获
```
