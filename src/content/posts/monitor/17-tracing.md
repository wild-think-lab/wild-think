---
title: 链路追踪：有了 trace_id，排障从两小时变成十分钟
description: 三种采样策略、span 的划分粒度、跨服务传递、以及"接了链路还是定位不到"的五个原因。
date: 2026-11-27
tags: [可观测, 链路追踪, OpenTelemetry]
---

### 它解决的问题

```
日志：知道"发生了什么"，但不知道"在哪一段慢"
指标：知道"整体慢"，但不知道"哪个请求慢"
链路：知道"这一次请求，每一段各花了多久"
```

**"一次慢请求的完整时间线"** 是链路追踪的核心价值。

### 一个 trace 的结构

```
trace（一次请求）
├── span A：HTTP 入口（10ms）
│   ├── span B：数据库查询（300ms）   ← 慢在这
│   └── span C：缓存读取（2ms）
└── span D：外部 API 调用（50ms）
```

**关键字段**：

```
trace_id    ：整条链路
span_id     ：这一段
parent_id   ：父 span
service     ：哪个服务
duration    ：耗时
attributes  ：标签（http.method、db.statement 等）
```

### 采样策略（成本控制的唯一手段）

```
① 头部采样（head-based）：入口决定"这次要不要采"
   简单，但"慢请求未必被采到"
② 尾部采样（tail-based）：先收集，事后按规则决定
   能"只保留慢请求与错误请求"，但需要缓冲与计算
③ 自适应采样：按流量动态调整比例
```

**"全量采集"在生产上几乎不可行**（存储与带宽成本爆炸）。

**推荐组合**：

```
常规请求：1%–10% 采样
错误请求：100% 保留
慢请求（> P99）：100% 保留
关键业务：100% 保留
```

**"只保留错误与慢请求"能覆盖 90% 的排障需求**。

### span 粒度怎么划

**太粗（一个 span 覆盖整个函数）** → 看不出细分。
**太细（每个函数一个 span）** → 开销大、噪音多。

**建议的粒度**：

```
① 每次外部调用一个 span（DB/Redis/HTTP/MQ）
② 每个"业务阶段"一个 span（校验、计算、落库）
③ 不要为"纯计算的小函数"建 span
```

**"外部调用必须有 span"** —— 这是性能问题的主要来源。

### 跨服务传递

```
HTTP：traceparent 头（W3C 标准）
MQ  ：消息属性里带 trace 上下文
gRPC：metadata
```

**W3C `traceparent` 格式**：

```
00-<trace-id>-<parent-id>-<flags>
```

**最容易出错的是"异步"**：

```
投递到 MQ 时没带上下文 → 消费者新建了一个 trace
→ 链路断在 MQ（"看不到后半段"）
```

### OpenTelemetry 的最简接入

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint="http://collector:4318")))
trace.set_tracer_provider(provider)

tracer = trace.get_tracer(__name__)

with tracer.start_as_current_span("handler") as span:
    span.set_attribute("user.id", uid)
    with tracer.start_as_current_span("db.query"):
        db.query(...)
```

**要点**：

```
① 用 BatchSpanProcessor（不要每条同步发送）
② 用自动埋点（框架/HTTP/DB 的 instrumentation 库）
③ 只手工埋"关键业务阶段"
```

### 五个"接了链路还是定位不到"的原因

**① trace_id 没打到日志里**

```
有链路但日志里没有 trace_id
→ 无法把日志与链路对上
```

**必须让日志框架自动注入 trace_id**。

**② 采样导致"要查的那次没采到"**

```
只有 1% 采样 → 用户投诉的那次大概率没数据
→ 用"错误/慢请求 100% 保留"
```

**③ 跨服务断了**

```
A 服务有 trace，B 服务新建了一个 → 两段链路对不上
→ 检查上下文传递（HTTP 头/MQ 属性）
```

**④ span 太粗**

```
只有一个"请求"span，耗时 500ms
→ 不知道是 DB 还是外部 API
```

**⑤ 时钟不同步**

```
跨机器的时间差 → span 的时间线错乱（子 span 显示在父 span 之外）
```

**"链路追踪强依赖时间同步"**，chrony 必须配。

### 一个"排障"的实际流程

```
① 用户报"下单慢"
② 从应用日志里拿到 trace_id
③ 在链路系统里打开这个 trace
④ 看到：入口 20ms，DB 400ms，外部支付 50ms
⑤ 结论：DB 查询慢
⑥ 从 span 的 db.statement 拿到具体 SQL
⑦ 去数据库侧查这条 SQL 的执行计划
```

**"从 trace 直接拿到慢 SQL"** 是这个流程最爽的地方。

### 与其他信号的关联

```
链路 → 日志：span 里带 trace_id，能跳转到日志
链路 → 指标：span 的 service/operation 能关联指标
链路 → 变更：span 带"发布版本"属性，能关联"是否刚发布"
```

**"span 里带 dd.version / deploy_id"** 能直接判断"是不是这次发布引起的"。

### 成本控制

```
① 采样（必做）
② 精简 attributes（不要塞整个请求体）
③ 缩短保留期（链路数据通常保留 7–30 天）
④ 只对关键服务做全量
```

**"把整个请求 body 塞进 span"是最贵的错误**。

### 检查清单

```
□ 有 trace_id 并注入日志
□ 错误/慢请求 100% 保留（其余采样）
□ 每次外部调用都有 span
□ HTTP/MQ/gRPC 上下文正确传递
□ 日志框架自动带 trace_id
□ 时钟同步（chrony）
□ span 带 service/version/deploy_id
□ attributes 精简（不塞大对象）
□ 有保留期策略
□ 排障流程演练过（从日志到 trace 到 SQL）
```
