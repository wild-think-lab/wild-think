---
title: Istio 的 ServiceEntry：把集群外的服务纳进网格
description: 为什么需要把外部依赖注册进网格、ServiceEntry 的三种解析模式、mTLS 与出口流量治理，以及"注册了但连不上"的排查路径。
date: 2022-11-02
tags: [Istio, ServiceEntry, 服务网格, 流量治理, Kubernetes]
---

### 问题背景

集群内的服务调用有 mTLS、重试、超时、遥测。一旦调用对象变成"集群外的一台老服务"，这些能力就全丢了：流量变成裸 TCP，出了问题没有任何观测。

ServiceEntry 的作用就是：**把集群外的地址，伪装成网格内的一个服务**，让它享受同样的治理能力。

### 三种解析模式

```yaml
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: legacy-erp
spec:
  hosts:
    - erp.example.com
  ports:
    - number: 443
      name: https
      protocol: TLS
  resolution: DNS            # NONE | STATIC | DNS
  location: MESH_EXTERNAL    # MESH_EXTERNAL | MESH_INTERNAL
```

| `resolution` | 含义 | 适用 |
| --- | --- | --- |
| `NONE` | 只做流量治理，不解析 | 只加超时/重试/遥测 |
| `STATIC` | 用 `endpoints` 里写死的 IP | 明确的固定后端 |
| `DNS` | 通过 DNS 异步解析 | 域名会变的情况 |

`location: MESH_EXTERNAL` 表示"这是外部服务"；如果要让外部流量进入网格，用 `MESH_INTERNAL` + `workloadSelector`。

### 一个完整例子：外部 ERP

```yaml
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: legacy-erp
spec:
  hosts: [erp.example.com]
  addresses: [10.10.20.31/32]
  ports:
    - number: 443
      name: https
      protocol: TLS
  resolution: STATIC
  location: MESH_EXTERNAL
  endpoints:
    - address: 10.10.20.31
```

配套的 VirtualService 控制行为：

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: legacy-erp
spec:
  hosts: [erp.example.com]
  http:
    - timeout: 3s
      retries:
        attempts: 2
        perTryTimeout: 1s
      route:
        - destination:
            host: erp.example.com
            port: { number: 443 }
```

这样"调 ERP 超时 3 秒、失败重试 2 次"就变成了网格策略，而不是每个应用自己实现。

### mTLS 出站

```yaml
spec:
  tls:
    mode: MUTUAL
    credentialName: erp-client-cert      # Secret: kubernetes.io/tls
```

前提：目标服务要接受这张客户端证书。很多老系统只支持单向 TLS，这时用 `mode: SIMPLE` + 服务端证书校验即可（`caCertificates` 指定 CA）。

### 出口流量治理的实际收益

- **超时与重试统一**：不用每个语言 SDK 各写一套。
- **可观测**：网格能看到"调用 ERP 的 P99 是 1.8s，错误率 4%"。
- **熔断/限流**：用 `DestinationRule` + outlierDetection 实现异常实例摘除。
- **白名单出口**：配合 `REGISTRY_ONLY` 模式，只允许已注册的外部域名出网——这是很强的安全收益。

```bash
# 全局只允许注册过的外部访问
istioctl install --set meshConfig.outboundTrafficPolicy.mode=REGISTRY_ONLY
```

### 注册了但连不上：排查顺序

1. **Sidecar 注入成功了吗**

```bash
kubectl get pod <pod> -o jsonpath='{.spec.containers[*].name}'
# 应看到 istio-proxy
```

2. **Envoy 的 cluster 建起来了吗**

```bash
istioctl proxy-config clusters <pod> | grep erp
istioctl proxy-config endpoints <pod> | grep erp
```

`endpoints` 为空 → 解析没成功（`resolution: NONE` 或 DNS 解析失败）。

3. **路由匹配吗**

```bash
istioctl proxy-config routes <pod> --name erp.example.com:443
```

4. **实际请求打到哪了**

```bash
istioctl proxy-config log <pod> --level debug
kubectl logs <pod> -c istio-proxy --tail=50
```

5. **DNS 能解析吗**（容器内）

```bash
kubectl exec -it <pod> -- getent hosts erp.example.com
```

`resolution: NONE` 是最容易踩的：它意味着"流量照原样走"，Envoy 不做 DNS 解析，此时 `endpoints` 必然为空，如果你期待有治理效果，就会觉得"配置了没生效"。

### 与 Ingress Gateway 的分工

- **入站**：外部流量进集群 → `Gateway` + `VirtualService`（或 `Ingress`）。
- **出站**：集群内调集群外 → `ServiceEntry`（+ `VirtualService` 控制行为）。
- **集群内互调**：Service + 网格自动发现，通常不用额外配置。

搞清这三个方向，配置就不会放错位置。

### 什么时候别用

- 只有一两个外部依赖，且团队没在跑网格 → 用应用层超时 + 网关代理更简单。
- 目标服务必须保持源 IP 可见（有些老系统做 IP 白名单），网格会改变源地址，需要额外配置 `trafficPolicy` 或走透传。

服务网格的价值是**把治理能力从代码里抽出来**。ServiceEntry 是它在边界上的那只手——用之前先想清楚"我要治理什么"，否则只是多了一层配置。
