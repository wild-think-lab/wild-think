---
title: Flink 上手：流处理到底在解决什么问题
description: 有界/无界流、事件时间与水位线、状态与 Checkpoint、以及五个"实时任务跑着跑着就不准了"的原因。
date: 2026-11-23
tags: [大数据, Flink, 流处理]
---

### 它和"定时跑批"的差别

```
批处理：数据攒一段时间，一次算完（延迟分钟/小时）
流处理：数据一到就算（延迟秒级），且要处理"乱序/迟到/故障"
```

**"用 cron 每分钟跑一次"** 在数据量大时会越跑越慢（无法追上）。

### 四个核心概念

```
① 有界/无界流：批是"有界流"的特例
② 事件时间（event time）：数据自带的发生时间
③ 水位线（watermark）：认为"这个时间之前的都到了"
④ 状态（state）：算子记住的中间结果
```

**"用处理时间算窗口"** → 迟到数据会算错（结果不稳定）。

### 一个最小作业

```java
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
env.enableCheckpointing(60_000);

DataStream<Event> src = env.addSource(new FlinkKafkaConsumer<>("events", new EventSchema(), props))
    .assignTimestampsAndWatermarks(
        WatermarkStrategy.<Event>forBoundedOutOfOrderness(Duration.ofSeconds(5))
            .withTimestampAssigner((e, ts) -> e.getTs()));

src.keyBy(Event::getUserId)
   .window(TumblingEventTimeWindows.of(Time.minutes(1)))
   .aggregate(new CountAgg(), new WindowResult())
   .addSink(new FlinkKafkaProducer<>("result", new ResultSchema(), props));

env.execute("count-per-minute");
```

**三个必配**：

```
① checkpoint（故障恢复）
② watermark（乱序容忍）
③ keyBy（并行与状态分区）
```

### 状态与 Checkpoint

```
Keyed State：按 key 分开（ValueState/ListState/MapState）
Operator State：算子级（如 Kafka offset）
Checkpoint：周期性快照（存 HDFS/S3）
Savepoint：手工触发，用于升级/迁移
```

**"重启后数据重复/丢失"** → 没开 checkpoint 或 source 不支持 offset 恢复。

### 五个"跑着跑着就不准"

**① 水位线太小**

```
乱序数据被丢进"已关闭的窗口" → 少算
```

**② 水位线太大**

```
窗口迟迟不触发 → 延迟高
```

**③ 状态无限增长**

```
按 userId 存全量历史 → 内存/磁盘爆
（要配 TTL：stateTtlConfig）
```

**④ 并行度与 key 倾斜**

```
某个 key 数据量是别人的 100 倍 → 单并发成瓶颈
```

**⑤ 精确一次只是"端到端"的承诺**

```
sink 不支持事务/幂等 → 至少一次（会重复）
```

### 状态 TTL

```java
StateTtlConfig ttl = StateTtlConfig.newBuilder(Duration.ofDays(7))
    .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
    .cleanupInRocksDBCompactFilter(1000)
    .build();
valueStateDescriptor.enableTtlConfig(ttl);
```

**"状态清了但业务要历史"** → 历史放外部存储，状态只留"窗口内"。

### 部署与运维

```
① 会话集群（Standalone）→ 小规模
② YARN/K8s（Application 模式）→ 生产常用
③ 高可用：多个 JobManager + ZK/K8s HA
```

```bash
flink run -m yarn-cluster -yn 4 -ys 2 -yjm 2g -ytm 4g job.jar
```

### 检查清单

```
□ 用事件时间（不是处理时间）
□ 水位线按乱序程度设置
□ 开 checkpoint（间隔与业务容忍匹配）
□ 状态有 TTL
□ key 分布检查过（无严重倾斜）
□ sink 幂等或事务（决定"精确一次"）
□ 有 savepoint 升级流程
□ 有背压/延迟监控
□ 并行度与资源匹配
□ 有"重启后一致性"验证
```
