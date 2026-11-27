---
title: Serverless 与事件驱动：什么时候值得
module: 进阶篇
summary: 函数计算/ Knative 的模型、冷启动与并发、事件驱动架构的取舍，五个"serverless 账单爆炸"的原因。
minutes: 45
---

### 两种"Serverless"

```
① 托管函数（FaaS）：云厂商按调用计费，无常驻进程
② Knative/KEDA：K8s 上按需扩缩到 0（自建）
```

**共同点**：不用管机器；**代价**：冷启动、状态无处放、可观测弱。

### 冷启动为什么致命

```
① 拉镜像 + 起容器（几百 ms 到几秒）
② JVM/语言运行时初始化
③ 连接池/DNS 首查
```

**判据**：P99 要求 < 100ms 的接口不适合 FaaS（除非预热/预留实例）。

### Knative 最小实践

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata: { name: echo }
spec:
  template:
    spec:
      containers:
        - image: registry.example.com/echo:1.0
```

```bash
kubectl get ksvc
# 缩容到 0（无流量时）
kubectl get pods   # 空闲后 Pod 消失
```

**要点**：请求进来才扩容（从 0 到 1 有冷启动）。

### KEDA：按事件扩缩

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: mq-worker }
spec:
  scaleTargetRef: { name: worker }
  minReplicaCount: 0
  maxReplicaCount: 30
  triggers:
    - type: rabbitmq
      metadata:
        queueName: orders
        mode: QueueLength
        value: "20"
```

**效果**：队列 20 条消息 → 加一个副本。

### 事件驱动架构（比 Serverless 更重要）

```
生产者 → 事件总线（Kafka/MQ）→ 多个消费者
```

**好处**：

```
① 解耦（加消费者不影响生产者）
② 削峰（消息堆积缓冲）
③ 可重放（Kafka 保留期内重算）
```

**代价**：

```
① 最终一致（要处理"还没处理完"）
② 幂等必须做（重复投递是常态）
③ 链路追踪要透传 trace
```

### 五个"账单爆炸"

**① 每请求一次外部调用**

```
函数里循环调 API → 计费按调用 × N
```

**② 冷启动频繁**

```
流量稀疏 + 缩到 0 → 每次都冷启动，还更贵
```

```yaml
# 保留最小副本
minReplicaCount: 1
```

**③ 日志/存储按量计费**

```
无采样全量日志 → 账单比计算还高
```

**④ 无限重试**

```
失败重试放大调用次数（要退避 + 上限）
```

**⑤ 没有并发上限**

```
突发流量 → 瞬间几千并发实例
```

### 幂等与顺序

```
① 每条消息带唯一 id（幂等键）
② 消费者本地/DB 去重
③ 分区键保证同一实体有序
```

**"MQ 保证不重复"** → 至少一次语义下必须自己幂等。

### 检查清单

```
□ 明确延迟要求（冷启动可接受吗）
□ 有预热/最小副本
□ 外部调用有缓存与批量
□ 有并发上限（防突发）
□ 日志采样与保留期
□ 重试有退避与上限
□ 消费者幂等
□ 分区键保证顺序
□ trace 透传
□ 有成本监控与预算告警
```
