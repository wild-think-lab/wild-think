---
title: Kafka 上手：分区、消费组与"积压了怎么办"
description: 用 KRaft 模式起一套单机集群、生产与消费的最小命令、可靠性三件套（acks/副本/幂等）、消费组与 offset 的关系，以及 lag 飙高时的排查路径。
date: 2026-11-27
tags: [Kafka, 消息队列, 中间件, 运维, 排障]
---

### 它到底解决什么问题

三个典型场景：

1. **解耦**：下单服务只负责"发一条事件"，积分、库存、短信各自订阅，谁挂了都不影响下单。
2. **削峰**：秒杀瞬时 5 万 QPS，写进队列慢慢消费，数据库只承受恒定压力。
3. **回溯**：日志、埋点先落 Kafka 再入湖，出问题可以重放。

不适合的：需要严格"发一条立刻处理完再返回"的同步调用，或者消息体特别大（单条建议 < 1MB）。

### 三个核心概念，别混

- **Topic / Partition**：主题是逻辑概念，分区是并行单位。一个分区在同一个消费组里**只能被一个消费者消费**——所以分区数就是消费并行度的上限。
- **Offset**：每条消息在分区内的位置编号，单调递增。消费者不是"删除消息"，而是提交 offset 表示"我读到哪了"。
- **Consumer Group**：同一个 group 内的消费者分摊分区；不同 group 各自独立消费全量。`group.id` 换个名字，等于换了一队人重新读。

### KRaft 模式下起一套单机

ZooKeeper 时代已经过去（3.9 之后 KRaft 是默认路线）。本地练手用一份配置起单节点：

```bash
# 生成集群 ID
kafka-storage.sh random-uuid

# 格式化存储目录（注意：这会清空数据目录）
kafka-storage.sh format -t <CLUSTER_ID> -c config/kraft/server.properties

# 启动
kafka-server-start.sh -daemon config/kraft/server.properties
```

关键配置（`config/kraft/server.properties`）：

```properties
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@127.0.0.1:9093
listeners=PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
advertised.listeners=PLAINTEXT://192.168.1.20:9092
log.dirs=/data/kafka-logs
num.partitions=3
default.replication.factor=1        # 单机只能是 1
offsets.topic.replication.factor=1
transaction.state.log.replication.factor=1
transaction.state.log.min.isr=1
```

**`advertised.listeners` 是最常错的一行**：客户端先连 `bootstrap.servers`，拿到 broker 返回的"我是 xxx:9092"，再去连那个地址。如果这里是 `localhost`，远程客户端就会一直连不上——很多人第一次部署都栽在这。

### 生产与消费的最小命令

```bash
# 建 topic：3 分区 1 副本
kafka-topics.sh --bootstrap-server localhost:9092 \
  --create --topic order-events \
  --partitions 3 --replication-factor 1

kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic order-events

# 生产（带 key 才能保证同一 key 落在同一分区，从而有序）
kafka-console-producer.sh --bootstrap-server localhost:9092 \
  --topic order-events \
  --property parse.key=true --property key.separator=:

# 消费（从头读、带 group）
kafka-console-consumer.sh --bootstrap-server localhost:9092 \
  --topic order-events --from-beginning \
  --group debug-reader \
  --property print.key=true --property print.partition=true
```

**有序性只保证在单分区内**。想要"同一订单的事件有序"，就用 `orderId` 做 key；想要全局有序，只能单分区，代价是吞吐。

### 可靠性三件套

```properties
# 生产者
acks=all                     # 等所有 ISR 副本落盘
enable.idempotence=true      # 幂等，防重发
max.in.flight.requests.per.connection=5   # 幂等开启后可放宽
retries=2147483647

# Broker
min.insync.replicas=2        # 3 副本时设 2，允许挂一台还能写
unclean.leader.election.enable=false      # 宁可不可用也不要数据错乱

# 消费者
enable.auto.commit=false     # 手动提交，处理成功后再 commit
isolation.level=read_committed
```

`acks=all` + `min.insync.replicas=2` + 3 副本，是"能扛一台机器故障且不丢消息"的标准组合。三者要一起调：只把 `acks=all` 打开而 `min.insync.replicas` 还是 1，等于没开。

### 积压了，按这个顺序查

```bash
# 1. 看每个 group 每个分区的 lag
kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group order-consumer

# 2. 看分区分布是否倾斜（某个分区 lag 特别大 = key 设计有问题）
kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic order-events

# 3. 看是不是有消费者掉线
kafka-consumer-groups.sh --bootstrap-server localhost:9092 --list
```

lag 持续上涨，按可能性排序：

1. **消费逻辑变慢**：加了远程调用、DB 慢查询。先看消费端 P99 耗时，不要在 Kafka 上找原因。
2. **分区数不够**：3 个分区最多 3 个消费者并行，扩到 6 个消费者有 3 个在空转。加分区能解决，但**加分区会打破 key 到分区的映射**，顺序语义要重新评估。
3. **key 倾斜**：99% 的消息都是同一个 key，全压在一个分区上。解法是加随机后缀（代价是局部无序）。
4. **rebalance 风暴**：消费者频繁上下线，每次 rebalance 期间全组暂停消费。查 `max.poll.interval.ms` 是否小于单批处理时间——处理太慢被踢出组，然后再回来，来回震荡。
5. **ISR 收缩**：某台 broker 磁盘慢，副本追不上，写入被限速串联。

### 消费端两个必设参数

```properties
max.poll.records=500          # 单次拉取条数，太大容易超时被踢
max.poll.interval.ms=300000   # 必须大于"一批消息最坏处理时间"
session.timeout.ms=10000
heartbeat.interval.ms=3000
```

`max.poll.interval.ms` 与新版本的心跳是分开的：心跳线程还在跳，但你处理太慢不 poll，照样被判定失联并触发 rebalance。这个坑排查起来特别费劲，因为它表现为"消费者一直在线，但 lag 不降"。

### 磁盘与保留策略

```properties
log.retention.hours=72
log.segment.bytes=1073741824
log.retention.check.interval.ms=300000
```

按时间保留最常用。要注意 Kafka 删除的是**整段 segment 文件**，所以实际保留时间可能比配置略长（一段没写满就不会被删）。

### 一句话总结

Kafka 的难点不在装，而在**分区数、key 设计、消费速度**这三件事的匹配。lag 是结果，不是原因。
