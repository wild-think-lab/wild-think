---
title: 第 3 章 · Service、Ingress 与集群内外的流量
module: 入门篇
summary: Service 的四种类型与 kube-proxy 的三种模式、DNS 怎么解析、Ingress 与 Ingress Controller 的分工、五个"连不上"的排查步骤。
minutes: 20
---

### Service 是什么

Service 给一组 Pod 一个**稳定的虚拟地址**（ClusterIP）和一个**稳定的 DNS 名**。Pod 会不断重建、IP 一直变，Service 是那层不动的抽象。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: order-api
  namespace: prod
spec:
  selector: { app: order-api }
  ports:
  - port: 80            # Service 暴露的端口
    targetPort: 8080    # 容器监听的端口
  type: ClusterIP
```

访问方式（同一个命名空间内）：

```
http://order-api
http://order-api.prod
http://order-api.prod.svc.cluster.local
```

三种写法等价，前两种靠 `/etc/resolv.conf` 的 search 域补全。

### 四种类型

| 类型 | 作用 | 用途 |
| --- | --- | --- |
| ClusterIP | 集群内虚拟 IP | 内部服务互调（默认） |
| NodePort | 每个节点开一个端口 | 测试、临时对外暴露 |
| LoadBalancer | 云厂商 LB | 生产对外（需云控制器） |
| ExternalName | CNAME 到外部域名 | 把外部服务伪装成集群内服务 |

`headless`（`clusterIP: None`）不是类型，而是一种特殊配置：不做负载均衡，DNS 返回所有 Pod IP，适合 StatefulSet（客户端要自己选实例）。

### kube-proxy 的三种模式

| 模式 | 原理 | 性能 | 现状 |
| --- | --- | --- | --- |
| userspace | 用户态转发 | 差 | 已淘汰 |
| iptables | 规则链 DNAT | 中（规则多时线性变慢） | 常见 |
| IPVS | 内核哈希表 | 好（规则多也稳定） | 大规模推荐 |
| eBPF（Cilium） | 绕过 kube-proxy | 最好 | 新集群趋势 |

规则上万条时 iptables 会明显变慢，这是大集群要换 IPVS 或 Cilium 的原因。

### Ingress：七层的入口

Service 是四层（IP+端口），Ingress 是七层（按域名/路径路由）。

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: prod
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
spec:
  ingressClassName: nginx
  tls:
  - hosts: [app.example.com]
    secretName: app-tls
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service: { name: order-api, port: { number: 80 } }
      - path: /
        pathType: Prefix
        backend:
          service: { name: web-front, port: { number: 80 } }
```

要点：

- **Ingress 只是规则**，真正干活的是 **Ingress Controller**（nginx-ingress、Traefik、APISIX）。
- `ingressClassName` 必须与已安装的 Controller 匹配，否则规则被忽略（最常见的"配了不生效"）。
- `pathType`：`Prefix` 按路径前缀，`Exact` 精确匹配，`ImplementationSpecific` 取决于 Controller。

网关层的常见能力（限流、鉴权、灰度）都靠 Controller 的注解实现，比如 nginx-ingress 的：

```yaml
nginx.ingress.kubernetes.io/proxy-body-size: "32m"
nginx.ingress.kubernetes.io/limit-rps: "50"
nginx.ingress.kubernetes.io/affinity: "cookie"
```

### 五个"连不上"的排查步骤

**① Service 有没有 Endpoints**

```bash
kubectl -n prod get endpoints order-api
```

如果 `ENDPOINTS` 是 `<none>`，说明 selector 没匹配上任何就绪的 Pod。检查：

```bash
kubectl -n prod get pods --show-labels | grep order-api
kubectl -n prod describe svc order-api | tail -5
```

`describe` 的 Events 会写 "has no endpoints"。

**② Pod 的 readinessProbe 是否通过**

Endpoints 只包含**就绪**的 Pod。Pod Running 但 Ready 为 `0/1`，就不会进 Endpoints。

```bash
kubectl get pods -o wide   # READY 列
```

**③ 端口对不对**

`port` / `targetPort` / `containerPort` 三者要串起来：Service 的 `targetPort` 必须等于容器的实际监听端口。容器里 `ss -lntp` 看一眼最稳。

**④ DNS 能不能解析**

```bash
kubectl run tmp --rm -it --image=busybox:1.36 --restart=Never -- \
  nslookup order-api.prod.svc.cluster.local
```

解析失败通常是 CoreDNS 问题（`kubectl -n kube-system get pods -l k8s-app=kube-dns`）。

**⑤ 直连能通吗**

```bash
kubectl run tmp --rm -it --image=nicolaka/netshoot --restart=Never -- \
  curl -sv http://order-api.prod:80/healthz
```

直连 Service 通、走 Ingress 不通 → 问题在 Ingress Controller；直连也不通 → 问题在 Service/Endpoints/NetworkPolicy。

**别忘了 NetworkPolicy**：默认全通，但一旦某个命名空间配了 deny-all，就会出现"同一集群内互相访问不了"。

```bash
kubectl -n prod get networkpolicy
```

### 外网访问的三条路径

```
① NodePort：简单粗暴，端口范围有限
② LoadBalancer + 云 LB：生产标准
③ Ingress + 一个对外 LB：自建集群最常见
```

自建集群的典型做法：用 MetalLB 给 Ingress Controller 一个局域网 IP，再把域名解析过去。
