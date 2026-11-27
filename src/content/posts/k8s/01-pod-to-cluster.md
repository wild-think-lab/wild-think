---
title: 从 Pod 到集群：Kubernetes 的六个核心对象
description: 不背概念，按"我要跑一个服务"的顺序走一遍：Pod、Deployment、Service、Ingress、ConfigMap/Secret、Namespace 各自解决什么问题。
date: 2026-11-27
tags: [Kubernetes, 容器, 编排, 云原生]
featured: true
---

### 用一条需求串起所有对象

需求：把一个 Web 服务跑起来，能被外部访问，能滚动升级，配置和密码不写死在镜像里，多套环境隔离。

K8s 的六个对象，正好对应这句话里的六个诉求。

### Pod：最小调度单位

Pod 是一组共享网络命名空间的容器。单容器 Pod 最常见，多容器（sidecar）用于日志采集、代理。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  containers:
    - name: app
      image: registry.example.com/web:1.0
      ports: [{ containerPort: 8080 }]
      resources:
        requests: { cpu: 100m, memory: 128Mi }
        limits:   { cpu: 500m, memory: 512Mi }
```

**不要直接创建 Pod**：Pod 挂了不会自愈，升级要手工删。生产用 Deployment 管 Pod。

### Deployment：让它自己维持"应该有 3 个副本"

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector: { matchLabels: { app: web } }
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: app
          image: registry.example.com/web:1.0
          ports: [{ containerPort: 8080 }]
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            initialDelaySeconds: 5
            periodSeconds: 5
```

`maxUnavailable: 0` 表示升级期间不允许有不可用副本，配合 readinessProbe 才是真正的零中断滚动。**没有探针的 Deployment 等于没有滚动升级**——K8s 只知道容器进程还活着，不知道业务能不能响应。

### Service：给它一个稳定入口

Pod IP 会变，Service 提供 ClusterIP + 稳定的 DNS 名。

```yaml
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  selector: { app: web }
  ports:
    - port: 80
      targetPort: 8080
```

四种类型分工：

| 类型 | 用途 |
| --- | --- |
| ClusterIP | 集群内部访问（默认） |
| NodePort | 临时对外暴露，30000–32767 |
| LoadBalancer | 云厂商 LB 或 MetalLB |
| ExternalName | 指向外部域名（CNAME） |

### Ingress：把域名路由进来

Service 只管端口，不管"哪个域名走哪个服务"。Ingress（通常配 Nginx Ingress Controller 或 Traefik）做七层路由与 TLS。

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
            backend:
              service: { name: web, port: { number: 80 } }
```

### ConfigMap 与 Secret：别把配置打进镜像

```bash
kubectl create configmap web-conf --from-file=app.yaml
kubectl create secret generic web-secret --from-literal=DB_PASS='xxx'
```

注意：**Secret 默认只是 base64，不是加密**。真正的做法是开启 etcd 加密（KMS）、或用 External Secrets 从 Vault 拉取、或干脆用 `SealedSecrets`。把 Secret 提交进 Git 是最常见的低级事故。

挂载方式：

```yaml
envFrom:
  - configMapRef: { name: web-conf }
env:
  - name: DB_PASS
    valueFrom:
      secretKeyRef: { name: web-secret, key: DB_PASS }
```

### Namespace：多环境隔离的边界

```bash
kubectl create namespace staging
kubectl -n staging apply -f deploy.yaml
```

Namespace 隔离的是名字与权限（配合 RBAC），**不隔离网络**（默认仍可互通）。要网络隔离得靠 NetworkPolicy。

### 一次完整的排障路径

```bash
kubectl get pods -o wide                     # 谁不在 Running
kubectl describe pod <pod>                   # Events 段最关键
kubectl logs <pod> --previous                # 上一个容器实例的日志（CrashLoop 必看）
kubectl exec -it <pod> -- sh                 # 进容器看现场
kubectl get events --sort-by=.lastTimestamp  # 集群级事件
kubectl top pod                              # 资源是否打满
```

常见状态与含义：

| 状态 | 含义 | 先查什么 |
| --- | --- | --- |
| Pending | 没调度上 | 资源 requests、节点污点、PVC 未绑定 |
| ImagePullBackOff | 拉镜像失败 | 仓库地址、imagePullSecret、网络 |
| CrashLoopBackOff | 启动即崩 | `logs --previous`、配置、依赖服务 |
| Running 但不通 | 探针/网络问题 | Service selector、readinessProbe、NetworkPolicy |

### 起步建议

1. 本地用 kind 或 k3s 起一套，先跑通"部署 → 访问 → 升级 → 回滚"。
2. 所有资源写 YAML 进 Git，用 `kubectl apply -f` 或 Helm，不要手敲 `kubectl run`。
3. 上线前把 requests/limits 设上，否则一个 Pod 能拖垮节点。
4. 探针（liveness/readiness）必须配，否则滚动升级就是赌博。
5. 记住回滚命令：`kubectl rollout undo deploy/web`——比修 bug 快得多。

K8s 的复杂度不在对象数量，而在**对象之间的契约**：Deployment 管副本，Service 管入口，Ingress 管域名，ConfigMap/Secret 管配置。把这四条捋顺，剩下的都是参数。
