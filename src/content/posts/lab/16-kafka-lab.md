---
title: Kafka 三节点实验：从零跑通生产消费与故障演练
description: 完整实验报告——单机三 broker、topic 分区与副本、消费者组再平衡、杀掉一个 broker 观察。
date: 2024-10-31
tags: [实验, Kafka, 消息队列]
---

### 实验目的

```
① 跑通三节点 KRaft 集群（不依赖 Zookeeper）
② 验证分区/副本/ISR
③ 观察消费者组再平衡
④ 杀掉一个 broker，验证高可用
```

### 环境

```
3 台（或 1 台起 3 个进程）CentOS 7 / Ubuntu 22.04
JDK 17
kafka 3.6.x
内存 ≥ 4G，磁盘 ≥ 20G
主机名：k1(10.0.0.11) k2(10.0.0.12) k3(10.0.0.13)
```

### 原理速览

```
Topic → 多个 Partition（并行单位）
Partition → 多个 Replica（1 leader + N follower）
ISR：与 leader 保持同步的副本集合
acks=all + min.insync.replicas=2 → 至少两份写成功
```

### 步骤 1：配置（每台）

```properties
# /opt/kafka/config/kraft/server.properties
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@10.0.0.11:9093,2@10.0.0.12:9093,3@10.0.0.13:9093
listeners=PLAINTEXT://10.0.0.11:9092,CONTROLLER://10.0.0.11:9093
advertised.listeners=PLAINTEXT://10.0.0.11:9092
log.dirs=/data/kafka
num.partitions=3
default.replication.factor=3
min.insync.replicas=2
```

**"advertised.listeners"** 写错是"能连上但收不到消息"的经典原因。

### 步骤 2：格式化并启动

```bash
# 只在第一台执行格式化（生成 cluster id）
KAFKA_CLUSTER_ID=$(bin/kafka-storage.sh random-uuid)
bin/kafka-storage.sh format -t $KAFKA_CLUSTER_ID -c config/kraft/server.properties
# 其余节点用同一个 cluster id
bin/kafka-storage.sh format -t $KAFKA_CLUSTER_ID -c config/kraft/server.properties

bin/kafka-server-start.sh -daemon config/kraft/server.properties
```

### 步骤 3：建 topic 并验证

```bash
bin/kafka-topics.sh --bootstrap-server 10.0.0.11:9092 \
  --create --topic demo --partitions 3 --replication-factor 3

bin/kafka-topics.sh --bootstrap-server 10.0.0.11:9092 --describe --topic demo
```

**期望**：

```
Partition 0: leader=1, replicas=1,2,3, isr=1,2,3
Partition 1: leader=2, ...
Partition 2: leader=3, ...
```

### 步骤 4：生产与消费

```bash
# 生产（带 key，便于观察分区）
bin/kafka-console-producer.sh --bootstrap-server 10.0.0.11:9092 --topic demo \
  --property parse.key=true --property key.separator=:

# 消费（同组两名消费者）
bin/kafka-console-consumer.sh --bootstrap-server 10.0.0.11:9092 --topic demo \
  --group g1 --property print.key=true
```

**观察**：同一 key 总是进同一分区（`hash(key) % partitions`）。

### 步骤 5：消费者组再平衡

```
① 起 1 个消费者 → 分到 3 个分区
② 起第 2 个 → 触发 rebalance，各分 1–2 个
③ 杀掉一个 → 再平衡，剩下的接管全部
```

```bash
bin/kafka-consumer-groups.sh --bootstrap-server 10.0.0.11:9092 \
  --describe --group g1
```

**看 LAG 列**：堆积量一目了然。

### 步骤 6：故障演练（杀 leader）

```bash
# 找到 partition 0 的 leader 节点，kill 它
bin/kafka-topics.sh --bootstrap-server 10.0.0.11:9092 --describe --topic demo | grep "Partition: 0"

# 再 describe
# 期望：leader 换成其他副本，isr 里少一个
```

**生产端表现**：

```
acks=all + min.insync.replicas=2 → 有一个副本可用，仍能写
如果同时杀两个 → 写入失败（NotEnoughReplicas）
```

**这个实验能直接说明"为什么 min.insync.replicas 不能等于 replication.factor"**（一挂就全停）。

### 常见问题

| 现象 | 原因 |
| --- | --- |
| `TimeoutException` 生产超时 | advertised.listeners 不通 / ISR 不足 |
| 消费者一直 rebalance | 处理太慢超过 `max.poll.interval.ms` |
| 数据看起来"丢了" | 消费 offset 未提交（enable.auto.commit 与处理失败） |
| 单分区热点 | key 分布不均（key 设计问题） |
| 磁盘涨很快 | retention 太长 / 没压缩 |

### 参数建议（起步）

```
acks=all
min.insync.replicas=2
replication.factor=3
retention.ms=7d（按业务）
compression.type=lz4
max.poll.records=500（按处理耗时调）
```

### 验证清单

```
□ 三节点集群起来（controller quorum 正常）
□ topic 3 分区 3 副本，ISR 满
□ 同 key 落同分区
□ 两个消费者分到不同分区
□ 杀一个 broker，leader 切换，写入不中断
□ 杀两个 broker，写入按预期失败
□ LAG 可观察
□ 重启 broker 后 ISR 恢复
```

### 总结

```
三节点 + acks=all + min.insync=2 是"能扛一台挂"的最小可用配置
再往上要考虑：跨机房（rack awareness）、容量与保留策略、监控 LAG
```
