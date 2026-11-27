---
title: 错误监控：Sentry 装上了，然后呢
description: 四类错误的分级、去重与聚合、告警阈值，以及五个"装了错误监控还是靠用户反馈才知道"的原因。
date: 2026-02-10
tags: [可观测, 错误监控, Sentry]
---

### 错误分四类

```
① 崩溃（Crash）：进程挂/异常未捕获
② 前端异常：JS 报错、请求失败
③ 后端 5xx：服务端错误
④ 业务异常：支付失败、下单失败（"非技术错误"）
```

**"只监控 ①②"** 会漏掉最影响收入的那类。

### 去重与聚合（关键）

```
Sentry 按"指纹"（stack trace + message）聚合
→ 1000 次同样的报错 = 1 个 issue（显示 1000 次）
```

**"没配指纹"** → 每个用户 ID 都变成新 issue（噪音爆炸）。

```python
sentry_sdk.init(
    dsn=DSN,
    traces_sample_rate=0.1,
    before_send=lambda event, hint: scrub_pii(event),
)
```

**`before_send` 做脱敏**（不要把手机号/身份证发给第三方）。

### 告警阈值

```
① 新 issue 出现 → 立即告警（第一次就报）
② 已有 issue 的"频率突增" → 告警（如 10 分钟内 > 100 次）
③ 错误率（错误/请求）> 阈值 → 告警（更贴近业务影响）
```

**"每条错误都发钉钉"** → 三天后所有人静音。

**推荐**：

```
新错误：即时通知
高频错误：聚合后 5 分钟一次
已知问题：静音到修复为止
```

### 四类错误的接入方式

**① 前端**

```js
window.addEventListener('error', e => Sentry.captureException(e.error));
window.addEventListener('unhandledrejection', e => Sentry.captureException(e.reason));
```

**② 后端**

```
语言 SDK 自动捕获未处理异常
→ 一定要设"错误上下文"（用户/租户/请求ID）
```

**③ 业务异常**

```python
sentry_sdk.capture_message("payment_failed", level="warning",
                          extras={"order_id": oid, "code": r.code})
```

**④ 依赖/下游**

```
下游 5xx / 超时 → 记成"依赖错误"（与自身错误分开）
```

**"业务异常"** 常被忽略，但它是"用户感知到的问题"。

### 五个"装了还是靠用户反馈"

**① 采样率 0（只收崩溃）**

```
traces_sample_rate=0 只影响性能追踪，错误仍会收
但有人设成了"只在 1% 用户开启监控"→ 大量漏报
```

**② 上报被拦截**

```
广告拦截器/网络策略挡掉了上报域名
→ 自建上报域名（不要用官方默认域名）
```

**③ 只在"测试环境"接入**

```
生产没接 → 用户先知道
```

**④ 没有"版本/环境"标签**

```
不知道是哪个版本引入的 → 无法定位
→ release + environment 必配
```

**⑤ 没人看**

```
有看板但不在值班流程里 → 等于没有
```

### 一个"值班可用"的配置

```
project 按"服务"划分
release = git sha（CI 自动注入）
environment = prod/staging
alert: 新 issue 即时 / 高频 5 分钟聚合 / 已知问题静音
owner: 每个 project 指定负责人
```

**"每个 project 有 owner"** 才能保证"有人处理"。

### 与链路/日志打通

```
错误事件里带 trace_id → 能跳到日志与链路
```

**"从一条错误直接看到那条请求的完整链路"** 是最省时间的排障方式。

### 检查清单

```
□ 前端 + 后端 + 业务异常都接入
□ 有指纹/聚合（不按用户 ID 拆）
□ 上报域名自有（不被拦截）
□ release/environment 标签
□ PII 脱敏（before_send）
□ 新错误即时告警
□ 高频错误聚合告警
□ 已知问题可静音
□ 每个 project 有 owner
□ 带 trace_id（与日志打通）
□ 看板在值班流程内
```
