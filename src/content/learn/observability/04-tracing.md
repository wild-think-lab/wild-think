---
title: 第 4 章 · 链路追踪：一次请求到底慢在哪
module: 入门篇
summary: traceId 与 span 的区别、上下文如何在进程间传递、采样与成本、如何从"接口慢 3 秒"定位到某一段，以及最常见的手工埋点方式。
minutes: 18
---

### 指标看不到的东西

```
接口 P99 = 3 秒。为什么？
```

可能的原因有十几个：数据库慢、某个下游慢、串行调用太多、GC 停顿、锁等待。指标只能告诉你"慢了"，不能告诉你"哪一段慢"。

链路追踪就是把一次请求拆成若干段，每段记录耗时与父子关系。

```
trace (一次请求)
├─ span A  网关：总耗时 3.2s
│  ├─ span B  鉴权服务：20ms
│  ├─ span C  订单服务：2.9s
│  │  ├─ span D  查数据库：2.7s   ← 问题在这
│  │  └─ span E  Redis：10ms
│  └─ span F  序列化响应：30ms
```

一眼就能看出根因在 D。

### 两个核心概念

| 概念 | 含义 |
| --- | --- |
| **traceId** | 一次请求的全局唯一标识，贯穿所有服务 |
| **span** | 一次操作（一次 DB 查询、一次 RPC），带开始时间、耗时、父 spanId |

一个 trace 由多个 span 组成树。**没有 span 的 traceId 只能做"日志串联"，做不了耗时归因**。

### 上下文怎么传

跨进程必须显式传递，通常用 HTTP header：

```
X-Trace-Id: 2f8a91c3d4e5
X-Span-Id:  a1b2c3
```

流程：

```
① 网关生成 traceId（或用客户端传入的），创建根 span
② 调下游时，把 traceId + 当前 spanId 塞进 header
③ 下游收到后，用它们作为父节点，创建自己的 span
④ 异步/消息队列场景：把 traceId 放进消息体或 header
```

最常见的失误：**中间某一段没传**（比如定时任务、消息消费、异步线程池），链路就断了。

### 手工埋点：不装 APM 也能做

不引入 OpenTelemetry 的完整方案，也可以先用最轻的方式拿到 80% 的价值：

```go
func WithTrace(ctx context.Context, name string) (context.Context, func()) {
    start := time.Now()
    ctx, span := appendSpan(ctx, name)
    return ctx, func() {
        log.Printf("trace=%s span=%s op=%s dur=%dms",
            TraceID(ctx), SpanID(ctx), name, time.Since(start).Milliseconds())
        span.End()
    }
}

// 使用
ctx, done := WithTrace(ctx, "db.query.orders")
rows, err := db.QueryContext(ctx, q)
done()
```

关键三点：

1. **耗时用结构化字段打出来**（`dur=2700ms`），日志平台就能按耗时过滤与排序。
2. **同一 traceId 的日志按时间排序**，就能手工还原出调用树。
3. 每条日志带 `op` 名称，等价于 span 名。

这套做法成本极低，足以支撑"接口慢 3 秒是哪个操作慢"的判断。

### 采样：成本与可见性的权衡

全量采集的成本很高（一次请求产生 10–50 个 span）。

三种采样策略：

| 策略 | 说明 | 适用 |
| --- | --- | --- |
| 头部采样 | 请求进来时按比例决定采不采 | 简单，但可能漏掉慢请求 |
| 尾部采样 | 请求结束后按"慢/错"决定保留 | 更适合排障（重点保留异常） |
| 自适应 | 按流量动态调比例 | 流量波动大时用 |

推荐：**错误与慢请求 100% 保留，正常请求 10% 采样**。这样既能定位问题，又不会把成本拉满。

### 从告警到根因的四步

```
① 告警：错误率飙升
② 看板：确认是哪个接口、哪个实例
③ 链路：按 traceId 或"最近 5 分钟的错误链路"过滤，找出最慢/出错的 span
④ 日志：拿该 span 的时间窗与 traceId 去日志平台查细节
```

没有链路时，第 ③ 步只能靠猜（"是不是数据库慢？"），然后逐个验证，耗时从分钟级变成小时级。

### 三个常见坑

**① 只有 traceId，没有 span**

结果只能"把所有日志按时间排"，无法区分串行与并行，也无法算某一段占总时间的比例。

**② 异步链路断掉**

```
请求 → 发消息到队列 → 消费者处理
```

如果消息体里没带 traceId，消费端就是一条孤立的新链路。修法：消息体固定带 `traceId` 字段。

**③ span 名字太粗**

`op=handle` 这种命名等于没命名。应该分层：`http.request`、`db.query.orders`、`redis.get.session`、`rpc.order.get`。

### 工具选择

| 方案 | 特点 |
| --- | --- |
| Jaeger | 开源标准，与 OTel 兼容 |
| Tempo | Grafana 生态，成本低（对象存储） |
| SkyWalking | 对 Java 友好，无需改代码（字节码增强） |
| 云厂商 APM | 开箱即用，按量计费 |

先能"用一个 traceId 串起来"，再考虑上完整方案。

### 验收

```
□ 网关生成 traceId，并透传到所有下游（含 MQ）
□ 关键操作（DB、缓存、RPC）有 span 或带 op+耗时 的结构化日志
□ 能用一个 traceId 画出调用树，并看出最慢的一段
□ 错误/慢请求 100% 保留
```
