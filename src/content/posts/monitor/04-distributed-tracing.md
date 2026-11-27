---
title: 链路追踪：一次慢请求到底慢在哪个服务
description: traceId 怎么串起全链路、OpenTelemetry 的最小落地、采样怎么定、以及"接了追踪但还是定位不到"的四个原因。
date: 2022-08-13
tags: [链路追踪, OpenTelemetry, Tempo, 可观测性, 排障]
---

### 指标与日志回答不了的问题

- 指标告诉你 P95 变成 800ms，但不知道是哪个下游慢。
- 日志告诉你每个服务的耗时，但拼不出一次请求的完整路径。
- 用户报"下单很慢"，你手里有 3 个服务、2 个数据库、1 个外部支付接口。

链路追踪补的就是这块：**一次请求经过哪些服务、每一跳花多久。**

### 三个概念

| 概念 | 含义 |
| --- | --- |
| Trace | 一次完整请求的调用链 |
| Span | 链路中的一段（一次 HTTP 调用 / 一次 SQL / 一次 Redis） |
| Context | 传播 traceId 与 spanId 的载体（HTTP Header、消息头） |

关键在**传播**：traceId 必须从入口一路带到最下游，任何一跳丢了，链路就断在那里。

### 最小落地：W3C traceparent

标准头：

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             版本-traceId-spanId-flags
```

- 网关生成或透传。
- 每个服务收到后继续往下游传。
- 异步消息（Kafka/RabbitMQ）要把 traceparent 放进消息头。

**nginx 透传示例**：

```nginx
proxy_set_header traceparent $http_traceparent;
add_header traceparent $http_traceparent always;
```

如果网关不生成，可以让第一个服务生成，但那样入口耗时统计就丢了。

### OpenTelemetry：一套 SDK 通吃

```yaml
# collector 配置（精简）
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }

processors:
  batch:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 75

exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls: { insecure: true }

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp/tempo]
```

应用侧（Go 为例）：

```go
tp, _ := otlptracehttp.New(ctx, otlptracehttp.WithEndpoint("collector:4318"), otlptracehttp.WithInsecure())
defer func() { _ = tp.Shutdown(ctx) }()

otel.SetTracerProvider(trace.NewTracerProvider(trace.WithBatcher(tp)))

// HTTP 中间件里自动从 traceparent 提取并继续 span
handler := otelhttp.NewHandler(mux, "order-api")
```

Java/Python/Node 都有对应的自动注入 agent，优先用自动注入，减少改代码。

### 采样：不采样会拖垮后端

100 QPS 的服务，每个请求 10 个 span，一天就是 8600 万个 span。存储直接爆。

| 策略 | 说明 | 适用 |
| --- | --- | --- |
| 头部采样（固定比例） | 入口按 10% 决定 | 简单，但可能漏掉罕见错误 |
| 尾部采样 | 先收全量，判定"是否错误/慢"再决定保留 | 推荐，能保住异常请求 |
| 按错误全采 | 所有 5xx 全保留 | 必须开 |

尾部采样配置示例（collector）：

```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 500 }
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: 5 }
```

规则：**错误与慢请求全采，正常请求按比例采。**

### "接了追踪但定位不到"的四个原因

1. **traceId 没传下去**：中间某个服务用了自定义 HTTP client，没透传 header。链路断在这里。
2. **异步任务丢上下文**：线程池/消息队列没传递 context，下游 traceId 变成新的。
3. **采样率太低**：用户报的那个请求恰好没被采样。解法：错误全采 + 支持按 traceId 强制采样。
4. **只有服务端 span，没有客户端 span**：看不到"调用下游花了多久"，只有自己处理的时间。

### 与日志的配合：从 traceId 一键跳转

日志里必须带 traceId：

```json
{"time":"2026-11-27T10:12:33Z","level":"info","traceId":"4bf92f35...","msg":"order created","orderNo":"NO001"}
```

Grafana 里配一条 link：从 Trace 页面点一下跳到 Loki 查 `traceId=xxx` 的日志。这个体验对排障价值极大。

### 该监控什么

- 每个服务的 P95 延迟（按 span kind 分）。
- 下游调用错误率（按目标服务分）。
- 慢 span Top 10（哪一跳最耗时）。
- 链路深度（超过 10 跳的调用要审视架构）。

### 落地顺序（别一上来全接）

1. 统一 traceparent 透传（网关 + 主要服务）。
2. 只接 1 条核心链路（如下单），验证端到端可查。
3. 错误全采，正常采样。
4. 日志加 traceId，配跳转。
5. 再逐步覆盖其他链路。

链路追踪不是"装个组件"，是**整条链路上的每个组件都愿意把上下文传下去**。这件事靠规范，不靠工具。
