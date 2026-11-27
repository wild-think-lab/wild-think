---
title: 部署 Kafka 集群：KRaft 模式三节点
module: 进阶篇
summary: 不用 ZooKeeper 的 KRaft 集群、副本与 ISR、生产参数、客户端幂等，五个"消息丢了"的原因。
minutes: 50
---

## 一、先弄懂它是什么

**Kafka 不是"消息队列"，它是"可重放的分布式提交日志"。**

```
生产者 → 追加写（append）到分区末尾 → 消费者按 offset 顺序读
                                     → offset 可回退，所以能重放
```

这个模型决定了一切：顺序写盘（快）、消费者自己记 offset（可重放）、消息不因消费而删除（按时间/大小保留）。

### 四个必须懂的概念

| 概念 | 含义 | 用错了会怎样 |
| --- | --- | --- |
| Topic | 逻辑分类 | 混用一个 topic，无法独立保留/扩分区 |
| Partition | 物理分片，也是并行单位 | 分区太少 → 单点瓶颈；太多 → 元数据与 rebalance 开销 |
| Offset | 分区内的序号 | 提交错了就是"重复消费"或"丢消息" |
| Replica / ISR | 副本与"同步副本集合" | ISR 收缩到 1 时，写成功也可能丢 |

### 为什么它能快

```
① 顺序写磁盘（比随机写快一个数量级）
② 零拷贝（sendfile）把数据直接从页缓存送到网卡
③ 批量 + 压缩（生产者攒批、broker 以段为单位）
④ 分区并行（吞吐随分区数近似线性增长，直到受限于盘/网）
```

### 它和 RabbitMQ 的差别（选型关键）

| 维度 | Kafka | RabbitMQ |
| --- | --- | --- |
| 模型 | 日志（可重放、按 offset） | 队列（消费即删、ack） |
| 顺序 | 分区内强序 | 单队列有序，多消费者竞争 |
| 保留 | 按时间/大小，可回放历史 | 消费后即消失（除 DLX） |
| 路由 | 分区键 | exchange + binding，灵活 |
| 适合 | 日志/事件流/CDC/削峰重放 | 任务分发/工作队列/RPC |

**判据**：需要"回放历史"或"同一份数据多个消费者各自进度" → Kafka；需要"复杂路由与优先级" → RabbitMQ。

### 可靠性三个旋钮（本质是一致性与可用性的取舍）

```
acks=all                 生产者等所有 ISR 落盘
min.insync.replicas=2    至少 2 个副本在 ISR 才允许写
enable.idempotence=true  生产者幂等（防重试导致的重复）
```

```
三者齐备 = "不丢不重"，代价是"1 台 broker 异常就可能写不进去"
只求快 = acks=1，代价是"leader 挂了可能丢最后一批"
```

这不是配置技巧，是 CAP 下的选择。

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
