---
title: 消息队列选型：Kafka、RocketMQ、RabbitMQ 到底怎么选
description: 三种模型的本质差异（日志/队列/路由）、吞吐与延迟对比、可靠性与顺序性，以及五个选型问题。
date: 2026-02-23
tags: [消息队列, Kafka, RocketMQ, RabbitMQ]
---

### 本质差异

```
Kafka      ：分布式提交日志（顺序追加 + 按 offset 消费）
RocketMQ   ：队列模型 + 强大的消息过滤与事务消息
RabbitMQ   ：AMQP + 灵活路由（exchange/queue/binding）
```

**一句话取舍**：

```
日志/流处理/大数据 → Kafka
电商/金融/需要事务消息与延迟消息 → RocketMQ
复杂路由/轻量任务队列/低吞吐 → RabbitMQ
```

### 对比表

| 维度 | Kafka | RocketMQ | RabbitMQ |
| --- | --- | --- | --- |
| 吞吐 | 极高（10w+/s） | 高（万级） | 中（千级） |
| 延迟 | ms 级（批量时更高） | ms 级 | μs–ms |
| 顺序性 | 分区内有序 | 队列内有序 | 队列内有序 |
| 事务消息 | 无（有幂等+事务表方案） | 原生支持 | 无 |
| 延迟消息 | 无（需外部实现） | 原生支持（18 个级别） | 插件支持 |
| 消息过滤 | 弱（靠 topic 划分） | 强（Tag/SQL92） | 强（routing key） |
| 路由 | 简单 | 简单 | 灵活 |
| 运维成本 | 高（依赖 ZK 或 KRaft） | 中 | 低 |
| 消息回溯 | 支持（改 offset） | 支持（按时间） | 不支持（消费即删） |

### Kafka 的关键认知

**① 它不"删"消息，只按时间/大小保留**

```
retention.ms / retention.bytes 决定保留多久
→ 可以重复消费（改 offset 重放）
```

**这是它做"流处理"的基础**。

**② 分区是并行的最小单位**

```
一个 topic 有 N 个分区 → 最多 N 个消费者并行
分区数决定上限（不是消费者数）
```

**分区数规划**：

```
目标吞吐 / 单分区吞吐（经验 10–50MB/s）
但分区过多 → 元数据与 rebalance 压力
一般 12–48 个分区比较合适
```

**③ 顺序性只在分区内**

```
同一个 key 永远进同一个分区 → 该 key 的消息有序
不同 key 之间无序
```

**这就是"用 key 保序"的原理**。

**④ 消费者组**

```
同组内：分区被分配给不同消费者（负载均衡）
不同组：各自独立消费全量（广播）
```

**"加消费者不增加消费能力"的常见误解**：只有同组内加才有效，且不超过分区数。

**⑤ acks 与可靠性**

```properties
acks=all              # 所有 ISR 确认（最安全）
min.insync.replicas=2 # 至少 2 副本写入（配 acks=all）
enable.idempotence=true  # 幂等（防重试重复）
```

**`acks=all + min.insync.replicas=2`** 是"不丢消息"的标准配置。

**⑥ 不要用 Kafka 做"任务队列"**

```
① 没有"单条确认"（只有 offset 提交）
② 消费失败重试机制弱（没有原生延迟重试）
③ 单条消息处理慢会阻塞整个分区
```

**这些正是 RocketMQ/RabbitMQ 擅长的**。

### RocketMQ 的关键认知

**① 事务消息**

```
半消息 → 执行本地事务 → 提交/回滚
→ 用于"本地事务与消息发送的最终一致"
```

**典型场景**：下单扣库存 + 发消息，两者必须一致。

**② 延迟消息**

```java
msg.setDelayTimeLevel(3);   // 对应 10s 级别（分级：1s/5s/10s/30s/1m/.../2h）
```

**限制**：只支持固定级别（不是任意时长），5.0 后支持任意时间。

**③ Tag 过滤**

```java
consumer.subscribe("OrderTopic", "TagA || TagB");
```

**在 broker 侧过滤**，减少网络传输（比 Kafka 的"消费端过滤"高效）。

**④ 顺序消息**

```
同一队列 + 同一线程消费 → 有序
需要自己保证"同一业务 key 进同一队列"
```

### RabbitMQ 的关键认知

**① Exchange 类型决定路由**

```
direct ：按 routing key 精确匹配
topic  ：按通配符匹配（order.*.created）
fanout ：广播到所有绑定队列
headers：按 header 匹配
```

**这是它"灵活"的来源**，也让配置变复杂。

**② 消息确认（ack）**

```python
channel.basic_consume(queue, on_message, auto_ack=False)
# 处理完手动 ack
channel.basic_ack(delivery_tag)
```

**`auto_ack=True` 是危险的**：消息一投递就删，消费者崩溃就丢消息。

**③ 持久化三件套**

```
① exchange durable
② queue durable
③ message delivery_mode=2
```

**三个都要，缺一个都可能丢**。

**④ 队列长度与积压**

```
队列积压 → 内存/磁盘上涨 → 可能触发流控（block 生产者）
```

**要配 `x-max-length` + 死信队列（DLX）**：

```
超过长度 → 转到死信队列 → 告警处理
```

### 五个选型问题（按顺序问自己）

```
① 要不要"重放历史消息"？要 → Kafka
② 要不要"事务消息/延迟消息"？要 → RocketMQ
③ 要不要"复杂路由"？要 → RabbitMQ
④ 吞吐量级？10w+/s → Kafka；万级 → RocketMQ；千级 → RabbitMQ
⑤ 团队运维能力？弱 → RabbitMQ（最简单）
```

### 消息不丢的三段保障

```
生产端：确认机制（Kafka acks=all / RocketMQ sendStatus / RabbitMQ confirm）
存储端：副本 + 刷盘（Kafka ISR / RocketMQ 同步双写 / RabbitMQ durable）
消费端：手动 ack + 幂等处理
```

**"至少一次"而不是"恰好一次"**：几乎所有人都用"至少一次 + 消费端幂等"。

**幂等的实现**：

```
① 业务唯一键去重表（insert 唯一索引冲突即忽略）
② Redis SETNX（带过期）
③ 状态机（只允许从状态 A 到 B，重复请求直接返回）
```

### 消息积压怎么办

**Kafka**：

```
① 增加分区数（不能减）
② 消费者扩容（不超过分区数）
③ 临时把消息转存到新 topic（"扩容 + 转发"方案）
④ 跳过非关键消息（改 offset，慎用）
```

**RocketMQ**：

```
① 增加消费线程
② 消费组扩容
③ 跳过堆积（重置位点，慎用）
```

**通用原则**：

```
先定位"消费慢"的根因（是下游慢、还是逻辑重）
→ 盲目扩容只是延迟爆点
```

### 检查清单

```
□ 选型按"重放/事务/路由/吞吐/运维"五问
□ Kafka 分区数覆盖目标吞吐
□ 用 key 保序（同 key 同分区）
□ acks=all + min.insync.replicas=2
□ 开启幂等生产者
□ 消费端至少一次 + 幂等处理
□ 有死信队列与告警
□ 监控消费积压（lag）
□ 有积压应急预案
□ 不用 Kafka 做复杂任务队列
```
