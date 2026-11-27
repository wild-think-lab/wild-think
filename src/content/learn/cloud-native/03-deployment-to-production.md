---
title: 从 Deployment 到"能上生产"：资源、探针、PDB 与滚动
module: 入门篇
summary: request/limit 的取舍、三类探针、PDB 与优雅终止、滚动发布的参数，以及"发布时零 5xx"的四件事。
minutes: 22
---

### 一个能上生产的 Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0        # 关键：保证发布期间不掉容量
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
    spec:
      terminationGracePeriodSeconds: 30
      containers:
      - name: api
        image: registry/api:sha-abc123
        ports: [{ containerPort: 8080 }]
        resources:
          requests: { cpu: 200m, memory: 256Mi }
          limits:   { cpu: "1",  memory: 512Mi }
        readinessProbe:
          httpGet: { path: /readyz, port: 8080 }
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 2
        livenessProbe:
          httpGet: { path: /healthz, port: 8080 }
          initialDelaySeconds: 20
          periodSeconds: 10
          failureThreshold: 3
        lifecycle:
          preStop:
            exec:
              command: ["sh", "-c", "sleep 5"]
```

### request 与 limit 的取舍

```
requests ：调度依据 + 保证量（决定"能不能被调度到节点"）
limits   ：上限（超过会被节流或 OOMKill）
```

**三种配法**：

| 配法 | CPU | 内存 | 效果 |
| --- | --- | --- | --- |
| request=limit | 200m | 256Mi | 稳定、可预测（推荐关键服务） |
| request < limit | 200m/1 | 256Mi/512Mi | 允许突发（但可能被节流） |
| 不设 limit | 200m | 256Mi | 可能吃满节点（危险） |

**内存 limit 设太小 → OOMKilled**：

```
现象：容器反复重启，Exit Code 137
→ 137 = 128 + 9（SIGKILL）
```

**"request 设得远低于实际"是超卖**：

```
10 个 Pod 各 request 100m，实际各用 800m → 节点 8 核被 8 个 Pod 打满
```

**建议 request 接近 P50–P75 的实际用量**。

### 三类探针的分工

```
startupProbe  ：启动慢的服务用（成功前不执行 liveness/readiness）
readinessProbe：能不能接流量（失败则从 Service 摘除，不重启）
livenessProbe ：还活着吗（失败则重启容器）
```

**最容易搞错的两件事**：

**① liveness 里查依赖**

```
查数据库 → 数据库抖动 → 全部容器被判死 → 集体重启 → 雪崩
→ liveness 只判断"进程自己是否正常"
```

**② readiness 太宽松**

```
Pod 还没连上数据库就 Ready → 接流量 → 用户看到 5xx
```

**"readiness 通过"应该代表"能正确处理请求"**。

### PDB（Pod Disruption Budget）

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-pdb
spec:
  minAvailable: 2          # 或 maxUnavailable: 1
  selector:
    matchLabels: { app: api }
```

**作用**：

```
节点维护（drain）时，K8s 保证"至少还有 2 个可用"
→ 不会因为一次 drain 把服务打挂
```

**"滚动升级/节点维护时被打挂"往往就是没配 PDB**。

### 优雅终止的三段

```
① Pod 被标记 Terminating → 从 Service endpoints 摘除
② 发 SIGTERM 给容器 → 应用开始处理"停止接收新请求 + 处理完存量"
③ 超过 terminationGracePeriodSeconds → SIGKILL
```

**常见错误**：

```
① 应用没处理 SIGTERM → 直接被 SIGKILL（连接被 reset）
② grace period 太短（长请求来不及完成）
③ 没有 preStop sleep → endpoint 摘除与 SIGTERM 之间有竞态（仍有请求打进来）
```

**`preStop: sleep 5`** 就是为这个竞态准备的（等 kube-proxy 更新完规则）。

### 滚动发布参数

```
maxSurge: 1          # 最多额外起 1 个（暂存容量）
maxUnavailable: 0    # 不允许"少一个"（保证容量不掉）
```

**代价**：

```
maxUnavailable=0 + maxSurge=1 → 需要多一份资源
如果资源紧张，可以 maxUnavailable=1（但容量会短暂下降）
```

**"发版时 QPS 掉了"** 往往是没有 maxSurge 或 maxUnavailable 太大。

### 让发布"零 5xx"的四件事

```
① readiness 准确（不接未准备好的实例）
② maxUnavailable=0（容量不掉）
③ preStop sleep + 处理 SIGTERM（不 reset 连接）
④ 客户端有重试（网络层瞬时失败的兜底）
```

**这四件事做完，滚动发布在正常流量下基本不会有 5xx**。

### 一个"验证发布"的方法

```bash
# 持续打流量，同时发布
while true; do curl -s -o /dev/null -w "%{http_code}\n" http://api/healthz; sleep 0.1; done

# 另一窗口
kubectl set image deploy/api api=registry/api:sha-new
kubectl rollout status deploy/api
```

**观察输出里有没有 502/503**。

**"发布时持续打流量并记录状态码"是最直接的验收**。

### 回滚

```bash
kubectl rollout history deploy/api
kubectl rollout undo deploy/api
kubectl rollout undo deploy/api --to-revision=2
```

**注意**：

```
① `--revision-to` 依赖 `--record`（已弃用），改用 Git 记录
② 回滚镜像要保留（不要立刻清理旧 tag）
③ 数据库结构变更的回滚是另一回事（不归 K8s 管）
```

**"镜像被清理导致回滚失败"是真实事故**。

### 检查清单

```
□ maxUnavailable: 0 + maxSurge: 1
□ request 接近实际用量
□ 内存 limit 不设太小（防 137）
□ liveness 不查依赖
□ readiness 准确反映"能服务"
□ 配 PDB（minAvailable/maxUnavailable）
□ terminationGracePeriodSeconds ≥ 最长请求
□ preStop sleep 5s
□ 应用处理 SIGTERM 并优雅关闭
□ 客户端有重试
□ 回滚镜像保留了
□ 发布时持续打流量验证
```
