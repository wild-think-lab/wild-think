---
title: 消息队列选型：Kafka、RabbitMQ、Redis 各自能干什么
description: 三者的语义差异（日志 vs 队列 vs 缓存）、投递保证与顺序、消费位点与重放、什么时候该选谁，以及三个最常见的误用。
date: 2023-06-09
tags: [消息队列, Kafka, RabbitMQ, Redis, 架构]
---

### 三者本质不同

| | Kafka | RabbitMQ | Redis（Stream/PubSub） |
| --- | --- | --- | --- |
| 模型 | 分布式追加日志 | 队列 + 交换机路由 | 内存数据结构 |
| 消息保留 | 持久（按时间/大小） | 消费后删除 | Stream 可保留，PubSub 不保留 |
| 消费位置 | 消费者自己记 offset | Broker 推送 | 消费者自己记（Stream） |
| 重放 | 支持（换 offset） | 不支持 | Stream 支持 |
| 吞吐 | 极高（百万级/秒） | 中（万级/秒） | 高（十万级） |
| 典型用途 | 事件流、日志、CDC | 任务分发、RPC | 轻量队列、实时通知 |

### Kafka：它其实是一个"可重放的日志"

关键概念：

```
Topic → Partition（并行单位）→ Offset（位置）
```

三个必须理解的点：

1. **顺序只在分区内保证**。同一订单的事件要按序，必须用订单 ID 做分区键：

```java
producer.send(new ProducerRecord<>("order-events", orderId, payload));
```

2. **消费者组**：组内每个分区只被一个消费者处理（并行），组间各自独立（广播）。

3. **offset 提交决定语义**：

| 提交时机 | 语义 | 风险 |
| --- | --- | --- |
| 处理前提交 | at-most-once | 处理失败则丢消息 |
| 处理后提交 | at-least-once | 失败重试会重复，**业务必须幂等** |
| 事务 | exactly-once（仅 Kafka 内部） | 跨系统做不到 |

**"至少一次"是生产主流**：重复几乎必然发生，幂等由业务兜底。

### RabbitMQ：路由是它的强项

```
Producer → Exchange（direct/topic/fanout/headers）→ Queue → Consumer
```

相比 Kafka 的优势：

- **灵活路由**：topic exchange 支持通配（`order.*.created`）。
- **优先级队列、延迟队列**（插件）。
- **单条确认**（ack/nack），失败可 requeue。

劣势：

- 消息消费后删除，**不能重放**。
- 堆积能力弱：队列积压会让内存/磁盘压力陡增（有流控，但吞吐会掉）。

判据：**需要"任务分发 + 复杂路由 + 单条确认"，用 RabbitMQ；需要"事件流 + 重放 + 高吞吐"，用 Kafka。**

### Redis：能当队列，但要知道边界

**PubSub**：发出去就丢，没有消费者就消失。适合"实时通知"，不适合业务消息。

**Stream**：有消费组、ack、pending 列表，能承载轻量队列。

```bash
XADD orders * orderId 1001 status created
XGROUP CREATE orders g1 0
XREADGROUP GROUP g1 c1 COUNT 10 BLOCK 2000 STREAMS orders >
XACK orders g1 <id>
```

限制：

- 全内存，堆积成本高。
- 持久化（RDB/AOF）不是为消息可靠性设计的，宕机可能丢最近数据。
- 没有分区/多副本的强一致性保证（Cluster 是分片，不是副本语义）。

适用：**低延迟、低价值、可丢可重试**的消息（验证码、通知、轻量任务）。

### 三个最常见的误用

**① 用 Kafka 做"任务队列"**

Kafka 没有单条 ack 与 requeue，做"一个任务被一个 worker 处理"要靠消费者组 + 手动 offset，出错重试的语义很绕。

任务分发用 RabbitMQ 或 SQS 更合适。Kafka 适合"事件广播 + 多方消费"。

**② 用 Redis 承载订单消息**

Redis 重启/主从切换会丢消息。订单这种"丢了要赔钱"的场景不能用它。

**③ 在 Kafka 里做"大消息"**

单条 > 1MB 的消息会显著拖慢 broker（页缓存压力、网络放大）。大 payload 应该存对象存储，消息里只放引用。

```json
{"type":"report.ready","objectKey":"reports/2026/11/abc.pdf","size":10485760}
```

### 消费端必须做的四件事

1. **幂等**：用业务唯一键（订单号 + 事件类型）去重。
2. **背压**：消费不过来时降速，不要无限堆积（Kafka 靠 lag 监控，RabbitMQ 靠 prefetch）。
3. **死信**：处理失败 N 次后进 DLQ，人工介入，不要无限重试。
4. **可观测**：lag、消费速率、失败率三个指标必须有告警。

```bash
# Kafka 消费滞后
kafka-consumer-groups.sh --bootstrap-server b:9092 --describe --group order-worker
```

`LAG` 持续增长就是消费端跟不上了。

### 选型决策

| 需求 | 选 |
| --- | --- |
| 事件流、需要重放、多下游订阅 | Kafka |
| 任务分发、复杂路由、单条确认 | RabbitMQ |
| 轻量、低延迟、可丢 | Redis Stream |
| 只要"发个通知" | 直接 HTTP 调用或 PubSub |
| 跨云、超大吞吐、需要托管 | 云厂商消息服务（SQS/MQ） |

一句话：**Kafka 是"日志"，RabbitMQ 是"邮局"，Redis 是"便签"**。选错不是性能问题，是语义问题。
