---
title: cert-manager：K8s 里证书全自动续期的正确姿势
description: 从安装到 Issuer/ClusterIssuer、三种校验方式的选择、证书轮换与"续期失败"的排查，附一份能直接用的配置。
date: 2023-07-17
tags: [Kubernetes, cert-manager, TLS, 证书]
---

### 它解决什么问题

```
手工申请证书 → 90 天后续期 → 有人忘了 → 全站 HTTPS 挂掉
```

cert-manager 的职责：**自动申请、自动续期、自动注入**。

### 安装

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.0/cert-manager.yaml

# 验证
kubectl -n cert-manager get pods
# 应该有 cert-manager、cert-manager-cainjector、cert-manager-webhook
```

**`cainjector` 的作用**：把 CA 证书注入到 APIService 的 CA bundle（webhook 要用）。它挂了会导致 webhook 调用失败。

### 两种 Issuer

| | Issuer | ClusterIssuer |
| --- | --- | --- |
| 作用范围 | 单个命名空间 | 全集群 |
| 适用 | 团队各自管理 | 平台统一签发 |

**建议**：Let's Encrypt 这类共享的用 `ClusterIssuer`；内部 CA 按团队隔离用 `Issuer`。

### Let's Encrypt + HTTP-01（最常用）

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    - http01:
        ingress:
          ingressClassName: nginx
```

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: app-tls
  namespace: prod
spec:
  secretName: app-tls
  dnsNames:
  - app.example.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

**Ingress 直接引用**：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app
  namespace: prod
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
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
          service:
            name: app
            port: { number: 80 }
```

**加了 annotation 就会自动创建 Certificate 与 Secret**，不用手写 Certificate。

### 三种校验方式

| 方式 | 原理 | 适用 |
| --- | --- | --- |
| HTTP-01 | 在 `/.well-known/acme-challenge/` 放文件 | 有公网 80 端口 |
| DNS-01 | 加一条 TXT 记录 | 泛域名、无公网端口 |
| TLS-ALPN-01 | 443 上的特殊握手 | 少见 |

**泛域名（wildcard）必须用 DNS-01**。

**DNS-01 配置（阿里云为例）**：

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-dns-key
    solvers:
    - dns01:
        webhook:
          groupName: acme.your-company.io
          solverName: alidns
          config:
            region: ""
            accessKeyIDSecretRef:
              name: alidns-credentials
              key: access-key-id
            accessKeySecretSecretRef:
              name: alidns-credentials
              key: access-key-secret
```

**注意**：DNS-01 需要第三方 webhook（如 `cert-manager-webhook-alidns`），官方只内置了几家（Cloudflare、Route53、DigitalOcean 等）。

**内置 DNS 提供商的例子（Cloudflare）**：

```yaml
    solvers:
    - dns01:
        cloudflare:
          apiTokenSecretRef:
            name: cloudflare-token
            key: api-token
```

### 证书续期的机制

```
默认在证书到期前 1/3 时间点续期
（90 天证书 → 约 30 天前开始续）
renewBefore 可以自定义：

spec:
  renewBefore: 720h     # 30 天
```

**续期是自动的，但要注意**：

```
① 续期时 Secret 会被更新
② Ingress/Nginx 要能"重新加载"（Nginx Ingress 会监听 Secret 变化）
③ 用 volume 挂载的 Pod 不会自动重载（要重启或应用自己监听）
```

**第③点最容易踩**：证书续了，但 Pod 里的证书文件没更新（volume 挂载的 Secret 会自动更新，但进程不重读）。

对策：应用支持 SIGHUP 重载，或用 `cert-manager` 的 `renew` 后触发滚动重启。

### 内部 CA（不依赖公网）

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: internal-ca
  secretName: internal-ca-keypair
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca-issuer
spec:
  ca:
    secretName: internal-ca-keypair
```

**用途**：

```
服务间 mTLS（Istio/Linkerd 之外的选择）
内部服务用可信证书（客户端要信任这个 CA）
```

### "续期失败"的排查

```bash
# 看 Certificate 状态
kubectl -n prod get certificate
kubectl -n prod describe certificate app-tls
# 关键：Events 与 Status.Conditions

# 看 CertificateRequest（每次申请/续期都会建一个）
kubectl -n prod get certificaterequest
kubectl -n prod describe certificaterequest <name>

# 看 Order（ACME 的订单）
kubectl -n prod get order

# 看 Challenge（ACME 的校验）
kubectl -n prod get challenge
kubectl -n prod describe challenge <name>
```

**排查链**：

```
Certificate → 为什么没就绪
  → CertificateRequest 是否 Ready
    → Order 是否 valid
      → Challenge 是否通过
```

**五个常见失败原因**：

```
① HTTP-01 校验失败：/.well-known 路径被应用的路由拦了（要放行）
② DNS-01 校验失败：DNS API 权限不足 / 记录没生效（等 TTL）
③ 速率限制：Let's Encrypt 每周 5 次同名证书（测试用 staging）
④ 端口不通：80 端口被防火墙挡，或 Ingress 没监听到
⑤ webhook 挂了：cainjector 或 webhook Pod 异常
```

**"放行 /.well-known" 的具体做法**：

```nginx
location ^~ /.well-known/acme-challenge/ {
    default_type "text/plain";
    root /var/www/html;
}
```

或者确认 Ingress 的路由不要把它转给后端应用。

### 用 staging 环境试，不要用 prod 试

```yaml
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
```

staging 的证书浏览器不信任，但可以验证"流程是否通"，避免把 prod 的速率限制用光。

### 检查清单

```
□ 用 ClusterIssuer 做平台统一签发
□ 生产用 prod endpoint，测试用 staging
□ 泛域名用 DNS-01，其余优先 HTTP-01
□ 放行 /.well-known/acme-challenge/
□ renewBefore 设置合理（默认 1/3，通常够）
□ 应用能重读证书（volume 更新但进程不重读是坑）
□ 有告警：证书剩余天数 < 14 天
□ 排查顺序：Certificate → CertificateRequest → Order → Challenge
□ cainjector/webhook 有监控
```
