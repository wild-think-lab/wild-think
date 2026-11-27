---
title: 部署 Kafka 集群：KRaft 模式三节点
module: 进阶篇
summary: 不用 ZooKeeper 的 KRaft 集群、副本与 ISR、生产参数、客户端幂等，五个"消息丢了"的原因。
minutes: 50
---

### KRaft 是什么

```
Kafka 3.3 起可用，3.7 起推荐：元数据由 Kafka 自己管（Quorum）
不再需要 ZooKeeper
```

**注意**：KRaft 集群一旦格式化，`cluster.id` 不可更改。

### 三节点配置（每台一份）

```properties
# /opt/kafka/config/kraft/server.properties
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@10.0.0.41:9093,2@10.0.0.42:9093,3@10.0.0.43:9093
listeners=PLAINTEXT://10.0.0.41:9092,CONTROLLER://10.0.0.41:9093
advertised.listeners=PLAINTEXT://10.0.0.41:9092
controller.listener.names=CONTROLLER
listener.security.protocol.map=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
log.dirs=/data/kafka
num.partitions=3
default.replication.factor=3
min.insync.replicas=2
```

**node.id 与 quorum.voters 必须逐台对应。**

### 格式化并启动（只做一次）

```bash
KAFKA_CLUSTER_ID=$(/opt/kafka/bin/kafka-storage.sh random-uuid)
/opt/kafka/bin/kafka-storage.sh format -t $KAFKA_CLUSTER_ID -c /opt/kafka/config/kraft/server.properties
```

```bash
systemctl enable --now kafka     # 三台都要用同一个 cluster id
```

**"每台各自 random-uuid"** → 三个独立集群，永远组不起来。

### 验证

```bash
/opt/kafka/bin/kafka-topics.sh --bootstrap-server 10.0.0.41:9092 --create \
  --topic orders --partitions 6 --replication-factor 3
/opt/kafka/bin/kafka-topics.sh --bootstrap-server 10.0.0.41:9092 --describe --topic orders
```

**判据**：`Leader` 与 `Replicas` 都是 3，`Isr` 也是 3 才算健康。

### 生产参数（顺序很重要）

```
acks=all              生产者等所有 ISR 确认
min.insync.replicas=2 至少 2 个副本在 ISR 才允许写
enable.idempotence=true 生产者幂等（防重）
retries + delivery.timeout.ms 要匹配
```

**代价**：acks=all + 副本 2 时，一台 broker 异常就会让写入变慢或失败（这是"正确"的行为，不是 bug）。

### 消费者侧

```properties
enable.auto.commit=false        # 手动提交
auto.offset.reset=earliest      # 新组从头读
max.poll.records=500            # 控制单批
```

**"自动提交 + 处理失败"** → offset 已提交，消息永久丢失。

### 五个"消息丢了"

**① 副本不足却继续写**

```
min.insync.replicas 没设 → 单副本也能写，盘坏就丢
```

**② 自动提交 offset**

```
处理失败但 offset 已前移
```

**③ 生产者没开幂等**

```
重试导致重复或乱序
```

**④ 分区键为空**

```
所有消息一个分区 → 单点瓶颈
```

**⑤ 磁盘满**

```
broker 进入离线 → 未同步的段丢失
```

### 容量与保留

```properties
log.retention.hours=72
log.segment.bytes=1073741824        # 1GB 段
log.retention.check.interval.ms=300000
```

**估算**：`日写入量 × 副本数 × 保留天数`，再留 30% 余量。

### 检查清单

```
□ 三节点奇数 Quorum
□ node.id / voters 一一对应
□ 统一 cluster id 格式化
□ 副本 3 + min.insync 2
□ 生产者 acks=all + 幂等
□ 消费者手动提交
□ 有分区键（保证顺序）
□ 有保留期与磁盘水位告警
□ 有 ISR 收缩告警
□ 有消费者 lag 监控
```
