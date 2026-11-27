---
title: 流量入口：Service、Ingress 与"为什么外部访问不到"
module: 熟练篇
summary: ClusterIP/NodePort/LB 三种 Service、Ingress 路由与注解、外部访问的四层链路，以及六个"访问不到"的排查点。
minutes: 20
---

### 外部访问的四层链路

```
客户端 → DNS → 负载均衡/SLB → Ingress Controller → Service → Pod
```

**"访问不到"必须逐层确认**，而不是直接看 Pod 日志。

### Service 的四种类型

```yaml
# ① ClusterIP（默认，集群内访问）
spec:
  type: ClusterIP
  selector: { app: api }
  ports: [{ port: 80, targetPort: 8080 }]

# ② NodePort（每个节点开一个端口）
spec:
  type: NodePort
  ports: [{ port: 80, targetPort: 8080, nodePort: 30080 }]

# ③ LoadBalancer（云厂商自动创建 SLB）
spec:
  type: LoadBalancer

# ④ ExternalName（CNAME 到外部域名）
spec:
  type: ExternalName
  externalName: db.example.com
```

**ClusterIP 的"虚拟 IP"不是真实网卡**：

```
它由 kube-proxy（iptables/ipvs）实现转发
→ 在节点上 ping 它不通，但 curl 可以
```

**"ping 不通但服务正常"是正常现象**。

### Endpoints 是最快的判断

```bash
kubectl get endpoints api
# NAME   ENDPOINTS                     AGE
# api    10.244.1.5:8080,10.244.2.7:8080:8080   5m
```

**Endpoints 为空 → Service 一定有问题**：

```
① selector 与 Pod label 不匹配
② Pod 没有 Ready（readinessProbe 未通过）
③ Pod 不存在
```

**"Service 名通了但没流量"先查 Endpoints**。

### Ingress 的关键点

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api
spec:
  ingressClassName: nginx
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /v1
        pathType: Prefix
        backend:
          service: { name: api, port: { number: 80 } }
```

**`pathType` 必须写**：

```
Exact  ：精确
Prefix ：按路径段（/v1 匹配 /v1、/v1/x，不匹配 /v1x）
ImplementationSpecific：由 controller 决定
```

**"path 匹配不上导致 404"** 是 Ingress 最常见的问题。

### 六个"访问不到"的排查点

**① DNS 没解析到 LB**

```bash
dig api.example.com
# 看是否指向 SLB/Ingress 的地址
```

**② SLB 健康检查失败**

```
现象：SLB 把所有后端标记为异常 → 502/503
检查：SLB 的健康检查路径与端口（是否指向 Ingress 的 80/443）
```

**③ Ingress 没有 controller**

```bash
kubectl get pods -n ingress-nginx
kubectl get ingressclass
```

**"Ingress 资源创建了但没用"** 是最常见的误解。

**④ host 不匹配**

```
请求的 Host 与 Ingress 的 host 不一致
→ Ingress 返回 404（默认后端）
```

**排查**：

```bash
curl -H "Host: api.example.com" http://<ingress-ip>/v1
```

**⑤ Service 端口写错**

```yaml
backend:
  service:
    name: api
    port:
      number: 80      # 这里应该是 Service 的 port，不是容器的 targetPort
```

**⑥ 网络策略/防火墙**

```
NetworkPolicy 拦住了 ingress-controller → pod 的流量
→ 用 kubectl exec 在 controller 里 curl 测试
```

### 一个"逐层验证"的方法

```bash
# 1. Pod 自身
kubectl exec -it <pod> -- curl -s localhost:8080/healthz

# 2. Service（在另一个 Pod 里）
kubectl run tmp --rm -it --image=curlimages/curl -- \
  curl -s http://api.default.svc.cluster.local/v1/healthz

# 3. Ingress（在 controller 里）
kubectl exec -n ingress-nginx deploy/ingress-nginx-controller -- \
  curl -s -H "Host: api.example.com" http://127.0.0.1/v1/healthz

# 4. 外部
curl -s https://api.example.com/v1/healthz
```

**"哪一步断了，问题就在哪一层"**。

### TLS 终止在哪一层

```
① SLB 终止（最常见）→ Ingress 里看不到 TLS
② Ingress 终止 → 证书存 Secret
③ 后端终止（mTLS）→ 证书要注入 Pod
```

**"证书配了但报错"往往是"终止层"没对上**：

```
在 SLB 终止，却在 Ingress 里配了 tls 段 → 行为不一致
```

### WebSocket 与长连接

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

**同时要检查 SLB 的空闲超时**：

```
SLB 默认 60s 空闲断开 → WebSocket 每分钟断一次
→ 要么调 SLB 超时，要么应用层发心跳
```

**"WebSocket 每分钟断"基本都是这个原因**。

### 大文件上传

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-body-size: "100m"
```

**三层都要放开**：

```
① SLB 的请求体限制
② Ingress 的 proxy-body-size
③ 应用的 multipart 限制
```

### 限流放哪层

```
① SLB/WAF：粗粒度（按 IP）
② Ingress：中粒度（按路由）
③ 应用：细粒度（按用户/业务）
```

**"只在一层做限流"容易被绕过**，但也不要三层都做（难调）。

### 检查清单

```
□ 知道四种 Service 类型与用途
□ 会看 Endpoints 判断 Service 是否可用
□ Ingress 有 controller + ingressClassName
□ pathType 明确
□ host 与请求一致
□ Service port 写的是 Service 的 port
□ 逐层验证（Pod → Service → Ingress → 外部）
□ 明确 TLS 终止层
□ WebSocket 调超时 + 心跳
□ 上传大小三层都放开
□ 限流分层且不重复
```
