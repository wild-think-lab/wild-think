---
title: Kafka 速查
summary: 集群运维常用命令、消费者组与积压排查、topic 管理、参数清单与故障判断。
group: Service
order: 2
tags: [kafka, 消息队列, 运维]
---

## 一、命令入口

```bash
# Kafka 2.x/3.x 统一用 --bootstrap-server
BOOT="kafka1:9092,kafka2:9092,kafka3:9092"

kafka-topics.sh            # topic 管理
kafka-consumer-groups.sh   # 消费组
kafka-console-producer.sh  # 生产测试
kafka-console-consumer.sh  # 消费测试
kafka-configs.sh           # 动态改配置
kafka-get-offsets.sh       # 查 offset
```

## 二、Topic 管理

```bash
# 建 topic
kafka-topics.sh --bootstrap-server $BOOT --create \
  --topic order.created --partitions 12 --replication-factor 3 \
  --config retention.ms=604800000

# 列表
kafka-topics.sh --bootstrap-server $BOOT --list

# 详情（分区、副本、ISR）
kafka-topics.sh --bootstrap-server $BOOT --describe --topic order.created

# 增加分区（只能增，不能减）
kafka-topics.sh --bootstrap-server $BOOT --alter \
  --topic order.created --partitions 24

# 删 topic
kafka-topics.sh --bootstrap-server $BOOT --delete --topic obsolete
```

**加分区会让 key 的 hash 落到不同分区** → 同 key 的顺序被打乱。

## 三、消费组排查（最常用）

```bash
# 看所有消费组
kafka-consumer-groups.sh --bootstrap-server $BOOT --list

# 看某组的积压
kafka-consumer-groups.sh --bootstrap-server $BOOT \
  --describe --group order-consumer

# 输出含义
# CURRENT-OFFSET  当前消费到的位置
# LOG-END-OFFSET  最新消息位置
# LAG             差值（正数=积压）
# LAG 为空        说明组没在消费

# 重置 offset（谨慎，会重复或丢消息）
kafka-consumer-groups.sh --bootstrap-server $BOOT --group order-consumer \
  --topic order.created --reset-offsets --to-earliest --execute
```

**重置 offset 前必须先停消费者**，否则会与正在运行的消费者冲突。

## 四、生产/消费测试

```bash
# 生产（带 key）
kafka-console-producer.sh --bootstrap-server $BOOT --topic test \
  --property parse.key=true --property key.separator=:

# 消费（从头）
kafka-console-consumer.sh --bootstrap-server $BOOT --topic test \
  --from-beginning --property print.key=true

# 只读最新 10 条
kafka-console-consumer.sh --bootstrap-server $BOOT --topic test \
  --max-messages 10
```

## 五、动态改配置

```bash
# topic 级
kafka-configs.sh --bootstrap-server $BOOT --entity-type topics \
  --entity-name order.created --alter \
  --add-config retention.ms=259200000,cleanup.policy=delete

# 查
kafka-configs.sh --bootstrap-server $BOOT --entity-type topics \
  --entity-name order.created --describe
```

## 六、关键参数（server.properties）

```properties
# 副本与写入
default.replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false

# 日志保留
log.retention.hours=72
log.segment.bytes=1073741824
log.retention.check.interval.ms=300000

# 网络
num.network.threads=8
num.io.threads=16
socket.send.buffer.bytes=102400
socket.receive.buffer.bytes=102400

# 分区上限
num.partitions=12
```

## 七、生产者参数（关键三条）

```properties
acks=all                  # 所有 ISR 确认（最安全）
retries=3
enable.idempotence=true   # 幂等（防重试导致重复）

# 批量（提高吞吐）
linger.ms=5
batch.size=16384
```

**`enable.idempotence=true` 会强制 `acks=all`**，两者要一起理解。

## 八、消费者参数

```properties
group.id=order-consumer
auto.offset.reset=earliest
enable.auto.commit=false     # 手动提交（处理成功后再提交）
max.poll.records=100
max.poll.interval.ms=900000  # 按处理耗时设
session.timeout.ms=45000
heartbeat.interval.ms=15000
fetch.min.bytes=1024
fetch.max.wait.ms=500
```

## 九、监控指标（JMX）

```bash
# 用 JMX 取关键指标
kafka-run-class.sh kafka.tools.JmxTool \
  --object-name kafka.server:type=BrokerTopicMetrics,name=MessagesInPerSec

# 常用对象
# kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions
# kafka.server:type=ReplicaManager,name=PartitionCount
# kafka.controller:type=KafkaController,name=ActiveControllerCount
# kafka.network:type=RequestChannel,name=RequestHandlerAvgIdlePercent
```

| 指标 | 阈值 | 含义 |
| --- | --- | --- |
| UnderReplicatedPartitions | >0 持续 5 分钟 | 副本不同步 |
| OfflinePartitionsCount | >0 | 分区不可用 |
| ActiveControllerCount | ≠1 | 脑裂或多 controller |
| RequestHandlerAvgIdlePercent | <30% | broker 忙 |
| LogFlushTime | 突增 | 磁盘慢 |

## 十、常见故障判断

| 现象 | 判断 | 处理 |
| --- | --- | --- |
| 消费者 LAG 持续涨 | 消费慢或崩 | 看 consumer 日志、加并发 |
| 生产端超时 | ISR 不足 | 查 UnderReplicated、磁盘 |
| 频繁 rebalance | 心跳/处理超时 | 调 max.poll.interval |
| 磁盘满 | 保留过大 | 缩短 retention 或扩容 |
| 分区不可用 | broker 不足 | 恢复 broker，等 ISR |

## 十一、常用速算

```
分区数：目标吞吐 / 单分区吞吐（10–50 MB/s）
副本：生产 3
磁盘：日量 × 保留天数 × 副本 × 1.3

例：日 500GB，3 天，3 副本
   500 × 3 × 3 × 1.3 ≈ 5.85 TB
```

## 十二、topic 命名

```
<系统>.<实体>.<用途>
order.created
order.cancel
pay.callback
```

## 十三、检查清单

```bash
# 1. 全部 topic 的副本是否齐全
kafka-topics.sh --bootstrap-server $BOOT --describe | grep -E "Isr:|Leader:"

# 2. 所有消费组的积压
kafka-consumer-groups.sh --bootstrap-server $BOOT --all-groups --describe

# 3. 磁盘
du -sh /data/kafka-logs/*

# 4. 控制器唯一
# 看 ActiveControllerCount = 1
```
