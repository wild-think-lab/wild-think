---
title: 链路追踪：一次请求走了哪
module: 进阶篇
summary: Trace 与 Span 的模型、OpenTelemetry 的接入姿势、采样与成本，五个"接了链路追踪还是断"的原因。
minutes: 45
---

### 模型先搞清楚

```
Trace：一次完整请求（一个 trace_id）
└─ Span：其中的一段（DB 查询、HTTP 调用、函数）
   ├─ 起止时间、耗时
   ├─ 父子关系（谁调用了谁）
   └─ 属性（状态码、SQL、目标服务）
```

**"只有日志没有 span"** → 知道出错但不知道慢在哪一段。

### 接入（OpenTelemetry 思路）

```
① SDK 埋点（自动 instrumentation 优先）
② 上下文传播（HTTP header 透传 traceparent）
③ Exporter 上报（OTLP → Collector → 后端）
```

```bash
# 环境变量是最省事的接入方式（多数语言支持）
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
OTEL_SERVICE_NAME=order-api
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

**要点**：采样 10%（parentbased 保证同链路一致采样）。

### 上下文传播（最关键的一步）

```
网关生成 traceparent → 应用接收并继续 → 出站请求带上
```

```
traceparent: 00-<trace_id>-<span_id>-01
```

**"只在入口生成、出站不带"** → 调用下游就断了，看不到跨服务。

### 与日志对齐

```json
{"ts":"...","level":"info","msg":"db query","trace_id":"a1b2","span_id":"c3d4","ms":42}
```

**日志里带 trace_id/span_id** → 可以在日志与 trace 之间互相跳转。

### 采样与成本

```
① 头部采样（trace 级别，10%）
② 尾端采样（只保留慢/错 trace，100% 错误）
③ 存储保留：热 1 天 / 冷 7 天
```

**"100% 全采样 + 永久保留"** → 存储成本爆炸，最后被迫关掉。

### 五个"接了还是断"

**① 出站不带 header**

```
跨服务 trace 断在第一跳
```

**② 异步/线程池丢上下文**

```
新线程拿不到 parent span → 变成新 trace
```

**③ 消息队列没透传**

```
Kafka 消息里没带 trace 字段 → 消费者另起一条
```

**④ 采样策略不一致**

```
上游采了、下游没采 → 半条链路
```

**⑤ 时钟不同步**

```
跨机器 span 时间错位 → 耗时算出负数
```

### 排障用法

```
慢请求 → 打开 trace → 看哪个 span 耗时占比最大
         → 展开属性（SQL / 目标地址 / 状态码）
```

**判据**：一个 P99 请求里 80% 时间在一个 span → 优化那一段。

### 检查清单

```
□ 统一 trace_id（入口生成）
□ 出站请求透传 traceparent
□ 异步/线程池有上下文传播
□ MQ 消息带 trace 字段
□ 采样策略全局一致（parentbased）
□ 错误/慢请求 100% 保留
□ 日志含 trace_id
□ 时钟同步（NTP）
□ 有保留期与成本上限
□ 有"trace 完整率"监控
```
