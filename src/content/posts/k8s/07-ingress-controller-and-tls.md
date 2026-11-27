---
title: Ingress 控制器与 TLS：把"域名 → 服务"这一层做扎实
description: 控制器怎么选、TLS 证书怎么自动签、超时与上传大小怎么配、以及 502/503/504 各自的真实原因。
date: 2023-05-10
tags: [Kubernetes, Ingress, TLS, Nginx, 排障]
---

### Ingress 只是规则，干活的是控制器

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "20m"
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
        backend: { service: { name: web, port: { number: 80 } } }
```

写了 Ingress 但没有任何控制器在跑，它就是个没有执行者的配置——**`kubectl get ingress` 的 ADDRESS 一栏会是空的**。

### 控制器怎么选

| 控制器 | 优势 | 代价 |
| --- | --- | --- |
| ingress-nginx | 最通用，注解生态最全，排障资料多 | 基于 Nginx，动态 reload 有轻微抖动 |
| Traefik | 配置模型好，自动发现，自带 dashboard | 注解与 Nginx 不兼容 |
| Envoy/Contour、Higress | 性能与可观测性强，支持更细的流量治理 | 学习成本高 |
| 云厂商 ALB Ingress | 免运维，与云负载均衡一体 | 绑定云，能力受限于厂商 |

选一个就够，别混跑：多个控制器靠 `ingressClassName` 区分，混跑最容易出"规则生效了但不是我想要的那个控制器"。

### TLS：两条路

**① 手动 Secret（自签或买的证书）**

```bash
kubectl create secret tls app-tls --cert=fullchain.pem --key=privkey.pem
```

**② cert-manager 自动签发（推荐）**

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef: { name: le-key }
    solvers:
    - http01:
        ingress: { ingressClassName: nginx }
```

然后在 Ingress 上加一个注解：

```yaml
annotations:
  cert-manager.io/cluster-issuer: letsencrypt
```

**两个必踩的坑**：

1. HTTP01 校验需要 80 端口能从公网访问到，内网集群签不出来 → 用 DNS01。
2. Let's Encrypt 有速率限制（同一域名每周 5 次重复签发），调试期用 staging server。

证书更新后 Secret 会自动变，但**老连接不会重载**。Nginx 控制器的 `--watch-ingress-without-class` 与 reload 策略要对，否则会看到"证书过期了但还是旧证书"。

### 关键注解：超时、大小、重试

```yaml
nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
nginx.ingress.kubernetes.io/proxy-body-size: "20m"
nginx.ingress.kubernetes.io/proxy-next-upstream: "error timeout http_502 http_503"
nginx.ingress.kubernetes.io/proxy-next-upstream-tries: "2"
```

注意：**注解拼错不会报错，只会静默失效**。`kubernetes.io` 少一个字母、`proxy-body-size` 写成 `body-size`，行为都只是"配置没生效"。所以调试时别只怀疑"配置不够"，先验证"配置真的进去了"。

判断注解有没有生效：

```bash
kubectl exec -n ingress-nginx deploy/ingress-nginx-controller -- \
  grep -r "proxy-body-size" /etc/nginx/ 2>/dev/null
```

### 502 / 503 / 504 的真实原因

| 状态码 | 含义 | 常见原因 |
| --- | --- | --- |
| 502 | 上游返回了非法响应 / 连接被拒 | 后端端口写错、Pod 没就绪、后端崩了、协议不匹配（HTTPS 当 HTTP 打） |
| 503 | 控制器自己没找到可用后端 | Service 无 Endpoints（标签不匹配、就绪探针失败） |
| 504 | 上游超时 | `proxy-read-timeout` 太小、后端慢、后端连接池耗尽 |

排 503 只需一条命令：

```bash
kubectl get endpoints web -o wide
```

`ENDPOINTS` 为空就是根因。空的三种原因：selector 不匹配 Pod 标签、Pod 没 Ready、端口名与 Service 的 targetPort 不一致。

排 502 看控制器日志：

```bash
kubectl logs -n ingress-nginx deploy/ingress-nginx-controller --tail=50
```

日志会直接给你 `connect() failed (111: Connection refused) while connecting to upstream` 这类明确信息。

### 灰度与多版本

**按权重**：

```yaml
annotations:
  nginx.ingress.kubernetes.io/canary: "true"
  nginx.ingress.kubernetes.io/canary-weight: "10"
```

**按 Header（内部测试）**：

```yaml
nginx.ingress.kubernetes.io/canary-by-header: "x-canary"
nginx.ingress.kubernetes.io/canary-by-header-value: "1"
```

同一 host 下建两个 Ingress：一个正常版本，一个带 canary 注解指向新 Service。

### 一个能自查的完整顺序

```
① kubectl get ingress → ADDRESS 是否有值
② kubectl describe ingress → Rules / Events
③ kubectl get endpoints <svc> → 是否为空
④ kubectl get pod -l <selector> → 是否 Ready
⑤ 从集群内 curl Service ClusterIP → 排除 Ingress 层
⑥ kubectl logs 控制器 → 看 upstream 错误
```

按这个顺序走，**不用猜**：前三步就能定位 80% 的问题。

### 生产建议

- 每个域名一个 Ingress，别把 20 个域名塞一个文件里（改一个要动全部）。
- 注解和 `spec` 用 Git 管理，别在控制台手改。
- 加一条"证书剩余天数"的拨测告警，比任何人工巡检可靠。
- 控制器副本至少 2 个，配 PDB，避免节点维护时整片不可用。
