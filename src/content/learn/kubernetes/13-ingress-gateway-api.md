---
title: Ingress 与 Gateway API 实战
module: 进阶篇
summary: Ingress 的局限、nginx-ingress 与 traefik 的取舍、Gateway API 的模型、灰度与 TLS，五个"入口配好还是不通"的原因。
minutes: 50
---

### Ingress 解决什么

```
外部流量 → 入口控制器 → Service → Pod
（一个 IP + 域名 + 路径路由）
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [app.example.com]
      secretName: app-tls
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: app, port: { number: 80 } }
```

**要点**：必须有 `ingressClassName`（新版集群默认类可能为空）。

### Ingress 的局限

```
① 只有 HTTP 语义（TCP/UDP 要额外 CRD）
② 路由能力弱（无权重、无 header 匹配、无流量切分）
③ 注解各家不一（可移植性差）
```

**"要在入口做灰度 5%"** → Ingress 注解能做，但很脆；Gateway API 更规范。

### Gateway API 三个角色

```
GatewayClass：控制器类型（nginx/traefik/istio）
Gateway：具体入口（监听端口、TLS）
HTTPRoute：路由规则（host/path/header/权重）
```

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: app }
spec:
  parentRefs: [{ name: main-gateway }]
  hostnames: ["app.example.com"]
  rules:
    - matches:
        - path: { type: PathPrefix, value: / }
      backendRefs:
        - name: app-v1
          port: 80
          weight: 90
        - name: app-v2
          port: 80
          weight: 10
```

**灰度 10%** 就是权重的事，不用靠注解。

### TLS

```bash
kubectl create secret tls app-tls --cert=tls.crt --key=tls.key
# 或 cert-manager 自动签发
```

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: app }
spec:
  secretName: app-tls
  dnsNames: ["app.example.com"]
  issuerRef: { name: letsencrypt, kind: ClusterIssuer }
```

**"证书过期没人知道"** → 加 `CertificateExpired` 告警。

### 五个"入口配好还是不通"

**① 没有 ingressClassName**

```
Ingress 存在但无人认领（ADDRESS 为空）
```

**② Service 的 targetPort 错**

```
Service 指向 8080，容器监听 80
```

**③ pathType 写错**

```
Exact 匹配 / 但实际请求 /api → 404
```

**④ 控制器没监听对应地址**

```
LoadBalancer 类型未分配外部 IP（裸机集群）
```

**⑤ TLS Secret 命名空间不对**

```
Ingress 在同 ns，Secret 在别处
```

### 排查命令

```bash
kubectl get ingress -A
kubectl describe ingress app
kubectl get svc app -o wide
kubectl get endpoints app       # 为空 = 选择器不匹配
kubectl logs -n ingress-nginx deploy/ingress-nginx-controller | tail -50
```

**`Endpoints` 为空**是最常见的"入口通但后端没有"。

### 检查清单

```
□ 明确 ingressClassName
□ 后端 Service endpoints 非空
□ pathType 与业务路径一致
□ TLS Secret 在同命名空间
□ 证书自动续期 + 到期告警
□ 有请求日志（入口层）
□ 限流/超时在入口配置
□ 灰度用权重/header（Gateway API）
□ 有 TCP/UDP 需求时的独立方案
□ 入口自身高可用（多副本）
```
