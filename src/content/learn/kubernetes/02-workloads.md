---
title: 第 2 章 · Pod 与工作负载：Deployment、StatefulSet、DaemonSet
module: 入门篇
summary: 四种工作负载各自适合什么、Pod 的生命周期与探针、副本数与滚动策略，以及"为什么我的 Pod 一直在重启"。
minutes: 22
---

### Pod 是什么

Pod 是**一个或几个容器的组合**，它们共享：

- 同一个网络命名空间（同一个 IP、同一组端口）
- 同一个存储卷（可以挂同一块 volume）
- 同一个生命周期（一起启停）

所以"一个容器"和"一个 Pod"在 90% 的场景下是一样的。用到多容器的情况只有几种：sidecar（日志采集、代理）、init 容器（初始化）、adapter。

### 四种工作负载

| 类型 | 保证什么 | 典型用途 |
| --- | --- | --- |
| **Deployment** | 副本数、滚动更新、回滚 | 无状态服务（API、Web） |
| **StatefulSet** | 稳定网络标识 + 稳定存储 + 有序启停 | 数据库、消息队列 |
| **DaemonSet** | 每个节点一个 | 日志采集、监控 agent、节点代理 |
| **Job / CronJob** | 跑完即止 / 定时跑 | 批处理、备份、迁移 |

判断标准很简单：

- 有状态、要固定身份 → StatefulSet
- 每台机器都要一份 → DaemonSet
- 一次性任务 → Job
- 其他 → Deployment

### 一个能用的 Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-api
  namespace: prod
spec:
  replicas: 3
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1              # 最多多起 1 个
      maxUnavailable: 0        # 不允许少
  selector:
    matchLabels: { app: order-api }    # 必须与 template 的 label 一致
  template:
    metadata:
      labels: { app: order-api }
    spec:
      containers:
      - name: api
        image: registry.example.com/order-api:1.4.2
        ports: [{ containerPort: 8080 }]
        resources:
          requests: { cpu: 100m, memory: 128Mi }
          limits:   { cpu: 1,    memory: 512Mi }
        env:
        - name: LOG_LEVEL
          value: info
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef: { name: order-secret, key: db-password }
        readinessProbe:
          httpGet: { path: /readyz, port: 8080 }
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet: { path: /healthz, port: 8080 }
          initialDelaySeconds: 20
          periodSeconds: 20
          failureThreshold: 3
```

四个必须写的字段：`resources`、`readinessProbe`、`livenessProbe`、`strategy`。缺了它们，滚动更新会出现"新 Pod 还没就绪就被当作可用"的流量空窗。

### 探针的三种类型与四种方式

类型：

- **liveness**：失败就重启容器。**不要在里查数据库**，依赖抖一下会全集群重启。
- **readiness**：失败就从 Endpoints 摘掉，不再接流量。查依赖可以放这里。
- **startup**：给慢启动应用用，启动成功前不执行 liveness。

方式：`httpGet`、`tcpSocket`、`exec`、`grpc`。

```yaml
startupProbe:
  httpGet: { path: /healthz, port: 8080 }
  failureThreshold: 30
  periodSeconds: 10      # 最多给 300 秒启动时间
```

Java 应用启动 2 分钟很常见，没有 startupProbe 就只能把 liveness 的 `initialDelaySeconds` 调得很大，结果运行中真挂了也发现得慢。

### 生命周期与优雅退出

Pod 删除时的顺序：

```
① 状态变 Terminating
② 从 Service Endpoints 摘除（停止接新流量）
③ 执行 preStop hook
④ 发送 SIGTERM 给容器主进程
⑤ 等 terminationGracePeriodSeconds（默认 30s）
⑥ 仍未退出 → SIGKILL
```

所以应用必须**处理 SIGTERM** 并主动关连接。Java Spring 要开 `server.shutdown=graceful`；Go 要 `srv.Shutdown(ctx)`。

`preStop` 的一个坑：从 Endpoints 摘除到客户端感知有延迟（kube-proxy 规则更新），可以加一个短 sleep：

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 5"]
```

### 为什么 Pod 一直重启

```bash
kubectl get pod -o wide
kubectl describe pod <name>      # 看 Events 与 Last State
kubectl logs <name> --previous   # 上一次崩溃的日志（关键）
kubectl get pod <name> -o jsonpath='{.status.containerStatuses[*].lastState.terminated}'
```

按退出码判断：

| 退出码 | 含义 | 常见原因 |
| --- | --- | --- |
| 0 | 正常退出 | 主进程跑完就结束了（该用 Job 不是 Deployment） |
| 1 | 应用错误 | 配置错、连不上依赖 |
| 137 | SIGKILL | 内存超 limit 被 OOMKilled |
| 143 | SIGTERM | 优雅退出超时被杀 |

`CrashLoopBackOff` 的退避时间会从 10s 指数增长到 5 分钟，所以"改完配置要等很久才重试"是正常的。想立刻验证可以 `kubectl rollout restart deploy/xxx`。

### 副本数与滚动策略的取舍

- `maxUnavailable: 0` + `maxSurge: 1`：更新期间容量不减，最安全，但需要多一份资源。
- `maxSurge: 0` + `maxUnavailable: 1`：省资源，但更新期间容量下降。
- `replicas: 3` 是常见起点：允许挂一台，还能滚动更新。

**容量规划**：如果单实例能扛 500 QPS，峰值 1200 QPS，那 3 个副本刚好够，但滚动更新时只剩 2 个（1000 QPS）就不够。要么加副本，要么用 `maxUnavailable: 0`。
