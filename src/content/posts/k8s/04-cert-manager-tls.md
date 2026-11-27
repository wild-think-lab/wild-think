---
title: cert-manager：让证书不再过期
description: Ingress 的 TLS 证书怎么自动签发与续期、内部 CA 怎么给内网服务发证、HTTP-01 与 DNS-01 怎么选，以及三个最常见的失败原因。
date: 2026-11-27
tags: [cert-manager, TLS, 证书, Kubernetes, 安全]
---

### 证书过期的代价

每年都有人因为证书过期导致整站不可用。手工续期的问题是：**它依赖某个人的记忆**，而记忆会失效。

cert-manager 做的事：把"申请 → 验证 → 签发 → 挂载 → 到期前自动续"变成集群里的自动流程。

### 三个对象

| 对象 | 作用 |
| --- | --- |
| Issuer / ClusterIssuer | 谁能签发证书（ACME、内部 CA、自签） |
| Certificate | 你要一张什么样的证书（域名、有效期） |
| Secret | 签出来的证书文件，Ingress 直接引用 |

### 安装与 Let's Encrypt（HTTP-01）

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.1/cert-manager.yaml
kubectl get pods -n cert-manager
```

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
      name: le-account-key
    solvers:
      - http01:
          ingress:
            class: nginx
```

Ingress 上只需三行注解：

```yaml
metadata:
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts: [app.example.com]
      secretName: app-tls
```

cert-manager 会自动建 Certificate 与 Secret，80 端口验证通过后签发。

### DNS-01：通配符与内网场景

```yaml
solvers:
  - dns01:
      cloudflare:
        apiTokenSecretRef:
          name: cf-token
          key: token
```

DNS-01 的好处：

- 支持通配符（`*.example.com`），一张证书搞定所有子域。
- 不需要 80 端口对外，适合内网/纯内网解析的域名。

代价：需要 DNS 服务商的 API 权限，且要配好 TXT 记录传播时间（大 zone 可能延迟几分钟）。

### 内部 CA：给内网服务发证

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca
spec:
  ca:
    secretName: internal-ca-keypair     # 内含 tls.crt / tls.key
```

生成自签 CA（一次性）：

```bash
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout ca.key -out ca.crt -subj "/CN=WildThink Internal CA"
kubectl create secret tls internal-ca-keypair --cert=ca.crt --key=ca.key -n cert-manager
```

然后把 `ca.crt` 分发到客户端信任库（或让服务端把中间证书链配全）。

### 验证

```bash
kubectl get certificate -A
kubectl describe certificate app-tls -n prod | tail -20
kubectl get secret app-tls -n prod -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -subject -dates
```

`describe` 的 Events 会直接告诉你卡在哪一步——这是排查证书问题的第一入口。

### 三个最常见的失败

**1. `Waiting for HTTP-01 challenge` 一直不结束**

原因是验证流量到不了。检查：

```bash
curl -I http://app.example.com/.well-known/acme-challenge/test
```

- DNS 没指对。
- 80 端口被防火墙/安全组挡。
- Ingress 有 rewrite 把 `/.well-known` 路径改坏了。
- 前面还有一层 CDN/WAF 拦了。

**2. `too many certificates already issued`**

Let's Encrypt 有速率限制（每域名每周 50 张）。开发环境反复删重建 Secret 很容易触发。解法：staging 用 `acme-staging-v02` 端点测试，验证通过再换 prod。

**3. 续期失败没人知道**

默认到期前 30 天续期。要有监控：

```bash
kubectl get certificate -A -o json | jq -r '.items[] | "\(.metadata.name) \(.status.renewalTime)"'
```

把 `renewalTime` 接入告警，或对到期时间做探测：

```bash
echo | openssl s_client -connect app.example.com:443 2>/dev/null | openssl x509 -noout -enddate
```

### 与其他组件的边界

- cert-manager 管的是**给 Ingress/网关用的证书**，不是 apiserver 的集群证书。
- 它签的 Secret 类型是 `kubernetes.io/tls`，Istio/nginx 都能直接引用。
- 用 Istio 时，`Gateway`/`VirtualService` 的 TLS 也能引用同一个 Secret。

### 建议的落地顺序

1. 先给一个测试域名配 staging 端点，跑通全流程。
2. 确认 80 端口可达或 DNS API 可用。
3. 切 prod，监控 `renewalTime`。
4. 内部服务用内部 CA，把根证书纳入客户端信任库。
5. 每年做一次"证书吊销/泄露"演练：知道怎么立刻换 key。

证书自动化最大的价值不是省事，是**把一件靠人记的事变成了靠系统保证的事**。
