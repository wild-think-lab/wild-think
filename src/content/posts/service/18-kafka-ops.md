---
title: Kafka 运维：从"能跑"到"敢上生产"
description: 分区与副本怎么定、ISR 与 leader 选举、消息积压的三层排查、消费组重平衡的坑，以及磁盘规划。
date: 2025-02-11
tags: [Kafka, 消息队列, 运维]
---

### 分区与副本怎么定

```
分区数 = 目标吞吐 / 单分区吞吐
单分区吞吐经验值：10–50 MB/s（取决于磁盘与消息大小）

副本数：生产至少 2，通常 3
```

**分区数不是越多越好**：

```
- 分区越多，元数据与控制器负担越大
- 分区数上限经验：单 broker 2000 以内
- 分区数一但定了，减少很麻烦（要重建 topic）
```

**常见错误**：一开始设 1 个分区，流量上来后要扩到 30 个 → 键的顺序被打乱（分区变了）。

对策：**建 topic 时就按未来 1–2 年的量规划**。

### ISR 与 leader 选举

```
ISR = In-Sync Replicas（与 leader 保持同步的副本）
```

关键参数：

```properties
# 至少几个副本在 ISR 才允许写入（建议 = 副本数 - 1 或副本数）
min.insync.replicas=2

# 生产者确认级别
acks=all          # 所有 ISR 都收到才成功（最安全，最慢）
acks=1            # leader 收到即成功（折中）
acks=0            # 不等确认（最快，会丢）

# 不干净的选举（可能选到落后很多的副本）
unclean.leader.election.enable=false    # 生产必须 false
```

**`unclean.leader.election.enable=true` 的后果**：broker 全挂后，可能选一个落后很多的消息副本当 leader → **数据回退**。

### 消息积压的三层排查

**第一层：消费速度是不是真的慢**

```bash
# 每个消费组的积压
kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --describe --group order-consumer

# 输出关键列
# CURRENT-OFFSET  LOG-END-OFFSET  LAG
```

`LAG` 持续增长 = 消费跟不上生产。

**第二层：消费者为什么慢**

```
① 单条处理耗时（下游 RPC/DB 慢）
② 消费者并发度不够（一个消费组内 consumer 数 < 分区数）
③ 批量参数不合理（fetch.min.bytes / max.poll.records）
④ 消费逻辑里有同步阻塞（重试、锁）
```

**第三层：是不是生产突然暴涨**

```bash
# topic 的写入速率
kafka-run-class.sh kafka.tools.JmxTool \
  --object-name kafka.server:type=BrokerTopicMetrics,name=MessagesInPerSec
```

### 消费组重平衡（rebalance）的坑

```
consumer 加入/离开/心跳超时 → 触发 rebalance
rebalance 期间整个消费组暂停消费（可能几十秒到几分钟）
```

**常见诱因**：

```
① max.poll.interval.ms 太小（处理慢的消费者被踢出组）
② session.timeout.ms / heartbeat.interval.ms 配置不当
③ 消费者频繁重启（发布时）
④ 分区数与消费者数不整除（总有消费者多分）
```

**参数建议**：

```properties
# 处理一条消息可能要几分钟的消费者，要放宽
max.poll.interval.ms=900000      # 15 分钟
max.poll.records=100             # 一次少拿点
session.timeout.ms=45000
heartbeat.interval.ms=15000
```

**"处理慢 + max.poll.interval 小"是 rebalance 最常见的原因**：消费者还在处理上一批，心跳线程没空发 → 被踢出 → 重平衡 → 又慢 → 循环。

### 磁盘规划

```
保留量 = 日写入量 × 保留天数 × 副本数 × 1.3（余量）

例：日写入 500GB，保留 3 天，3 副本
   500 × 3 × 3 × 1.3 ≈ 5.85 TB
```

```properties
log.retention.hours=72
log.segment.bytes=1073741824        # 1GB 一个 segment
log.retention.check.interval.ms=300000
```

**不要用 RAID5 跑 Kafka**：写放大 + 重建慢。用 RAID10 或多块独立盘（JBOD）。

### 关键监控指标

| 指标 | 阈值 | 含义 |
| --- | --- | --- |
| UnderReplicatedPartitions | > 0 持续 5 分钟 | 副本不同步 |
| OfflinePartitionsCount | > 0 | 分区不可用 |
| ActiveControllerCount | 应为 1 | 多 controller = 脑裂 |
| RequestHandlerAvgIdlePercent | < 30% | broker 忙不过来 |
| LogFlushTime | 突增 | 磁盘慢 |
| consumer lag | 持续增长 | 消费跟不上 |

### 常见故障与处理

**① 一个 broker 挂 → 分区 leader 切换**

```
影响：短暂（秒级）不可用（取决于 controller 选举）
处理：确认 ISR 恢复，UnderReplicated 归零
```

**② 全部 broker 挂 → 恢复后可能有副本落后**

```
处理：等 ISR 收敛；不要开 unclean election
```

**③ 磁盘满**

```
Kafka 的应对：停止写入（不删数据）
处理：扩容或缩短 retention；临时清旧 segment（谨慎）
```

**④ 消费者一直 rebalance**

```
排查：max.poll.interval、处理耗时、consumer 数量与分区数
```

### 主题命名与治理

```
命名：<系统>.<实体>.<用途>
例：order.created、order.cancel、pay.callback

规范：
- 一个业务一个 topic，不要"大杂烩"
- 生产与消费方在 topic 名上达成一致（写进接口文档）
- 设置合理的 retention（不是永久保留）
- 定期清理无消费者的 topic（会占用磁盘）
```

### 检查清单

```
□ 分区数按 1–2 年规划（不是按当前量）
□ 副本数 ≥ 3（生产）
□ min.insync.replicas ≥ 2
□ acks=all（关键业务）
□ unclean.leader.election.enable=false
□ 磁盘按"日量 × 天数 × 副本 × 1.3"规划
□ 不用 RAID5
□ 监控 UnderReplicated / Offline / Controller / Lag
□ max.poll.interval 按处理耗时设置
□ topic 命名规范且 retention 合理
```
