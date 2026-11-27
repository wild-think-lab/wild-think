---
title: Kubernetes Ingress 深入：从"能用"到"能撑住"
description: Ingress、IngressClass、Gateway API 的区别，注解与 TLS、五种必须掌握的场景配置，以及 ingress-nginx 的调优。
date: 2026-11-27
tags: [Kubernetes, Ingress, 网络]
---

### Ingress 是什么，不是什么

```
Ingress = "HTTP 层的路由规则声明"（只是资源对象）
Ingress Controller = 真正干活的组件（如 ingress-nginx 的 Pod）
```

**没有 Ingress Controller，Ingress 资源毫无作用**。这是新手最常踩的坑。

```bash
# 确认有没有 controller
kubectl get pods -n ingress-nginx
kubectl get ingressclass
```

### IngressClass：K8s 1.18+ 的"指定用哪个 controller"

```yaml
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: nginx
spec:
  controller: k8s.io/ingress-nginx
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  ingressClassName: nginx      # 指向上面的 IngressClass
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web
            port:
              number: 80
```

**`pathType` 三选一**：

```
Exact            ：精确匹配 /
Prefix           ：前缀匹配（/api 匹配 /api、/api/x）
ImplementationSpecific ：由 controller 决定（通常等价 Prefix）
```

**注意 `Prefix` 是按"路径段"匹配的**：`/api` 不会匹配 `/apixxx`。这是 1.18 后的重要变化。

### 场景一：多域名单集群

```yaml
spec:
  tls:
  - hosts:
    - app.example.com
    - api.example.com
    secretName: wildcard-tls
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend: { service: { name: web, port: { number: 80 } } }
  - host: api.example.com
    http:
      paths:
      - path: /v1
        pathType: Prefix
        backend: { service: { name: api, port: { number: 8080 } } }
```

**通配符证书**（`*.example.com`）能覆盖所有子域，最省事。

### 场景二：HTTPS 强制跳转

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
```

**`ssl-redirect` vs `force-ssl-redirect`**：

```
ssl-redirect：有 TLS 配置时才跳转
force-ssl-redirect：即使 ingress 上没直接配 TLS（由外层终止）也跳
```

**如果 TLS 在负载均衡层终止**（Ingress 里看不到 TLS），要用 `force-ssl-redirect`。

### 场景三：重写路径

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /api(/|$)(.*)
        pathType: ImplementationSpecific
        backend: { service: { name: api, port: { number: 8080 } } }
```

**`/$2` 是正则捕获组的引用**：

```
请求 /api/users → 转发到后端 /users
```

**README 里的捕获组写法在 Nginx 0.22+ 变了**：旧版用 `/$1` 配合 `(.*)`，新版要求带上 `(/|$)` 前缀组。**这是升级后"路径全错"的经典原因**。

### 场景四：大文件上传

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-body-size: "100m"
  nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
```

**默认 `proxy-body-size` 是 1m**，上传稍大文件就 413。

### 场景五：灰度与限流

```yaml
# 金丝雀（按 header 分流到 canary 版本）
annotations:
  nginx.ingress.kubernetes.io/canary: "true"
  nginx.ingress.kubernetes.io/canary-weight: "10"
  # 或按 header
  nginx.ingress.kubernetes.io/canary-by-header: "x-canary"
  nginx.ingress.kubernetes.io/canary-by-header-value: "always"
```

**金丝雀注解只在"额外的 Ingress 资源"上生效**（与主 Ingress 同 host/path），weight 是百分比。

```yaml
# 限流
annotations:
  nginx.ingress.kubernetes.io/limit-rps: "20"
  nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"
  nginx.ingress.kubernetes.io/limit-connections: "10"
```

### 场景六：WebSocket 与 SSE

**ingress-nginx 默认就支持 WebSocket**（升级时自动处理），但要注意超时：

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

**SSE 必须关 buffering**：

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-buffering: "off"
```

### 场景七：客户端真实 IP

```yaml
annotations:
  nginx.ingress.kubernetes.io/use-forwarded-headers: "true"
  nginx.ingress.kubernetes.io/enable-realip: "true"
```

**为什么重要**：

```
如果前面还有一层 SLB/CDN，Ingress 看到的 remote_addr 是 SLB 的 IP
→ 日志、限流、风控全部失真
```

**`use-forwarded-headers`** 让 ingress 信任 `X-Forwarded-For`。

**安全警告**：

```
只在"前面确实有一层可信代理"时开启
如果 ingress 直接暴露公网，开了等于允许伪造 IP
```

### ingress-nginx 的调优

**① controller 副本与资源**

```yaml
spec:
  replicas: 2
  template:
    spec:
      containers:
      - args:
        - --ingress-class=nginx
        - --configmap=$(POD_NAMESPACE)/nginx-configuration
        - --enable-ssl-passthrough
        resources:
          requests: { cpu: 100m, memory: 256Mi }
          limits:   { cpu: "1", memory: 512Mi }
```

**为什么不用单副本**：

```
单副本 → 那个 Pod 挂了，所有流量中断（直到重建）
双副本 → 滚动时仍有可用实例
```

**② 全局 configmap 改 worker 参数**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-configuration
data:
  worker-processes: "4"
  worker-connections: "65535"
  keep-alive-requests: "1000"
  upstream-keepalive-connections: "32"
  proxy-body-size: "20m"
```

**`worker-processes` 和 `worker-connections`** 是并发能力的基础。

**③ HPA（按 CPU 扩容）**

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ingress-nginx
spec:
  scaleTargetRef: { kind: Deployment, name: ingress-nginx-controller }
  minReplicas: 2
  maxReplicas: 6
  metrics:
  - type: Resource
    resource: { name: cpu, target: { type: Utilization, averageUtilization: 60 } }
```

**注意**：扩容需要 30s+，突发流量顶不住，**不要把它当兜底方案**。

### Gateway API：Ingress 的继任者

```
Ingress        ：能力有限（只有 host/path，注解全靠 controller 自定义）
Gateway API    ：标准化了更多能力（header 匹配、流量拆分、跨命名空间路由）
```

**迁移建议**：

```
新项目如无特殊限制，可考虑 Gateway API（更规范）
存量 ingress-nginx 继续用没问题（注解很成熟）
```

**Ingress 的注解本质是"controller 私有协议"**，换 controller 就失效 —— Gateway API 解决了这个。

### 排查：404 / 503 / 502 在 Ingress 层

```bash
# 1. Ingress 是否真的绑到了 controller
kubectl describe ingress web | grep -A5 Rules

# 2. controller 日志
kubectl logs -n ingress-nginx deploy/ingress-nginx-controller | tail -50

# 3. 后端 Service 的 endpoints 是否就绪
kubectl get endpoints web

# 4. 直接在 controller 里访问后端
kubectl exec -n ingress-nginx deploy/ingress-nginx-controller -- \
  curl -s http://web.default.svc.cluster.local:80/
```

**三个典型结论**：

```
404：host/path 不匹配（最常见是 pathType 写错，或 host 拼错）
503：endpoints 为空（Pod 没就绪 / selector 不匹配）
502：后端响应异常（和后端服务排错同理）
```

**`kubectl get endpoints` 是快速判断后端是否可用的最佳命令**。

### 检查清单

```
□ 确认 controller 存在且 ingresses 绑到 ingressClassName
□ pathType 明确（Prefix/Exact）
□ 多域名配通配符证书
□ 按需开启 force-ssl-redirect
□ rewrite 注意捕获组版本差异
□ proxy-body-size 放开
□ WebSocket/SSE 调超时且关 buffering
□ 前端有代理时配 use-forwarded-headers（且仅信任可信代理）
□ controller 至少 2 副本
□ configmap 调 worker 参数
□ 有 HPA（但知道它有延迟）
□ 会看 endpoints + controller 日志排 404/503/502
```
