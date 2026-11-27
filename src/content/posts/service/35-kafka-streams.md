---
title: Kafka Streams：不用集群也能算流
description: 它与 Flink 的定位差异、KTable 与全局状态、changelog 与容错、五个"用它算错了"的原因。
date: 2026-11-23
tags: [消息队列, 流处理, Kafka]
---

### 定位差异

```
Flink：独立集群、强（事件时间/大规模状态/复杂窗口）
Kafka Streams：库，跑在你的应用里，无独立集群
```

**"只有一个消费场景"** → Kafka Streams 更轻（部署就是部署应用）。

### 三个抽象

```
KStream：只追加的记录流
KTable：变更日志（key → 最新值，可看成"表"）
GlobalKTable：全量复制（适合小维表）
```

**"用 KStream 做 join"** → 只能窗口内 join；维表要用 KTable。

### 一个最小拓扑

```java
StreamsBuilder b = new StreamsBuilder();

KStream<String, Order> orders = b.stream("orders");
KTable<String, User> users = b.table("users");

KStream<String, String> out = orders
    .filter((k, v) -> v.getAmount() > 100)
    .join(users, (o, u) -> o.getId() + ":" + u.getLevel())
    .to("big-orders");

Properties p = new Properties();
p.put(StreamsConfig.APPLICATION_ID_CONFIG, "order-enrich");
p.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");
p.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG, StreamsConfig.EXACTLY_ONCE_V2);
new KafkaStreams(b.build(), p).start();
```

**`APPLICATION_ID`** 决定消费组与 changelog 主题名（改了就"从零开始"）。

### 状态与容错

```
本地状态（RocksDB）+ changelog 主题（远端备份）
故障时：从 changelog 重建本地状态
```

**"重启后状态没了"** → changelog 被删或 `application.id` 变了。

### 五个"用它算错了"

**① 用处理时间做窗口**

```
迟到数据算错 → 用 event time + grace
```

```java
TimeWindows.ofSizeAndGrace(Duration.ofMinutes(1), Duration.ofSeconds(30))
```

**② KTable 的"更新"没处理好**

```
同一 key 的旧值被覆盖 → 聚合结果与预期不同
```

**③ 分区数变了**

```
state 按分区分布 → 改分区会导致状态重分布（耗时/丢）
```

**④ 拓扑改了没重启**

```
原地升级拓扑 → 状态不兼容（要用新 application.id 重建）
```

**⑤ exactly-once 只在 Kafka 内部**

```
写到外部系统（DB/HTTP）就不保证 → 要幂等
```

### 与 Flink 的选择判据

```
选 Kafka Streams：
① 已在 Kafka 生态
② 逻辑不复杂（过滤/join/聚合）
③ 想少一套集群

选 Flink：
① 需要复杂窗口/事件时间语义
② 状态大（TB 级）
③ 多源多汇（非 Kafka）
```

### 运维要点

```
① 监控 lag 与重启次数
② changelog 主题要有足够保留
③ 有"状态重建耗时"预估
④ 扩缩容时注意"分区与实例"的对应
```

### 检查清单

```
□ application.id 稳定
□ 用事件时间 + grace
□ changelog 保留足够
□ 分区数变更流程明确
□ 拓扑升级用新 id 或兼容方案
□ 外部写入幂等
□ 有 lag 与重启监控
□ 有状态重建演练
□ 选择理由写清（vs Flink）
```
