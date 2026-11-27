---
title: RabbitMQ 运维：队列堆积、连接风暴与消息不丢
description: 三类常见故障的定位命令、镜像队列的取舍、以及五个"消息丢了/卡了"的真实原因。
date: 2026-11-27
tags: [服务, 消息队列, RabbitMQ]
---

### 三个必看的命令

```bash
rabbitmqctl status
rabbitmqctl list_queues name messages consumers memory
rabbitmqctl list_connections peer_host state
```

**`list_queues` 是排查第一站**：

```
messages  ：堆积数量
consumers ：有没有消费者（0 = 没人消费）
memory    ：队列占用
```

**"堆积 + consumers=0"** → 消费者挂了/连不上，不是 RabbitMQ 的问题。

### 队列堆积的四个原因

```
① 没人消费（消费者/进程挂了）
② 消费慢于生产（下游慢）
③ prefetch 太小（消费者空转等）
④ 单队列单消费者（未做并发消费）
```

**排查顺序**：

```bash
rabbitmqctl list_queues name messages consumers message_stats.publish_details.rate message_stats.deliver_get_details.rate
```

**"publish rate > deliver rate"** → 消费跟不上。

### prefetch（最容易被忽略的调参）

```
prefetch = 每个消费者预取多少条
太小 → 消费者往返频繁，吞吐低
太大 → 单消费者囤积，负载不均
```

**经验值**：

```
① 消费耗时长（>100ms）→ prefetch 1–10
② 消费很快（<5ms）→ prefetch 50–250
③ 多消费者时 prefetch 要小，才能公平分配
```

**"30 个消费者但只有一个在干活"** → prefetch 太大。

### 连接风暴

```
现象：连接数暴涨 → 内存涨 → 节点不稳
原因：应用没有复用连接（每个请求建一条）
```

**检查**：

```bash
rabbitmqctl list_connections | wc -l
rabbitmqctl list_connections peer_host state | sort | uniq -c | head
```

**治理**：

```
① 应用侧用连接池（不要每次新建）
② 设置 connection_max / channel_max
③ 心跳（heartbeat）合理（默认 60s，别关掉）
```

**"关掉心跳"** 会让"死连接"长期占用资源（故障叠加）。

### 镜像队列 vs 仲裁队列

| 类型 | 说明 | 现状 |
| --- | --- | --- |
| 经典镜像队列 | 全量复制到多个节点 | 已不推荐（同步开销大） |
| 仲裁队列（quorum） | Raft 复制，多数派提交 | 3.8+ 推荐 |

```bash
rabbitmqctl set_policy ha-quorum "^orders" \
  '{"queue-master-locator":"min-master","dead-letter-exchange":"dlx"}' \
  --apply-to queues --priority 1
```

**注意**：

```
仲裁队列要求磁盘 fsync 能力好
→ 磁盘慢会导致 "queue stalled"
```

### 五个"消息丢了/卡了"

**① 生产端没开 confirm**

```
basic_publish 不确认 → 连接断了也不知道消息是否到达
```

**② 消费端 autoAck**

```
autoAck=true → 消息一投递就"确认"，消费崩了消息就没了
```

**必须手动 ack（`basic_ack`）**。

**③ 没有持久化**

```
queue durable=false 或 message delivery_mode=1
→ broker 重启，消息全没
```

**④ 消费端抛异常没 nack**

```
消息既没 ack 也没 reject → 卡在 unacked
→ 表现为"队列 messages=0 但 consumers 不推进"
```

**⑤ 死信队列没配**

```
消费失败的消息被反复重投 → CPU 打满
→ 配 DLX + 最大重试次数
```

### 三个"看起来相似"的现象区分

| 现象 | 含义 | 动作 |
| --- | --- | --- |
| messages 高 + consumers>0 | 消费慢 | 扩容消费者/优化逻辑 |
| messages 高 + consumers=0 | 无消费者 | 检查消费者进程/连接 |
| messages=0 + unacked 高 | 消费卡住 | 检查消费者处理时长/ack |

```bash
rabbitmqctl list_queues name messages messages_unacknowledged consumers
```

### 一个"可靠"的生产者/消费者写法

```python
# 生产：confirm + 持久化
ch.confirm_delivery()
ch.basic_publish(exchange='', routing_key='orders',
                 body=msg,
                 properties=pika.BasicProperties(delivery_mode=2))

# 消费：手动 ack + prefetch
ch.basic_qos(prefetch_count=10)
def on_msg(ch, method, props, body):
    try:
        handle(body)
        ch.basic_ack(method.delivery_tag)
    except Exception:
        ch.basic_nack(method.delivery_tag, requeue=False)  # 进死信
```

**`requeue=False` + DLX** 才能避免"毒消息无限重投"。

### 检查清单

```
□ 队列/消息都持久化
□ 生产者开 confirm
□ 消费者手动 ack + prefetch 合理
□ 配 DLX + 最大重试
□ 连接池复用（不新建）
□ 心跳开启
□ 队列用仲裁队列（新部署）
□ 有堆积告警（messages 阈值）
□ 有消费者数监控（=0 立即告警）
□ 磁盘 fsync 性能达标（SSD）
```
