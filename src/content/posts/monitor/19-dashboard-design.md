---
title: 看板设计：让 Grafana 在故障时真的有用
description: 三栏布局、四个必看面板、变量与下钻，以及五个"看板很多但没人看"的原因。
date: 2025-12-21
tags: [可观测, Grafana, 监控]
---

### 看板分三类（别混）

```
① 服务看板（SRE 值班用）：现在有没有问题
② 诊断看板（排障用）：哪里出了问题
③ 业务看板（产品/管理层看）：业务健康度
```

**"一个看板想满足所有人"** = 谁都不好用。

### 服务看板的四栏结构

```
顶部：SLO 概览（可用性/延迟/错误率/流量）—— 一眼判断"有没有事"
中部左：错误（5xx 率、异常日志量）
中部右：延迟（P50/P90/P99 曲线）
底部：资源（CPU/内存/连接数/队列）
```

**"顶部四个数"是值班第一眼要看的东西**。

### 四个必看面板

**① 请求速率（QPS）**

```promql
sum(rate(http_requests_total[1m])) by (service)
```

**② 错误率（按状态码）**

```promql
sum(rate(http_requests_total{code=~"5.."}[5m])) by (service)
/ sum(rate(http_requests_total[5m])) by (service)
```

**③ 延迟分位（一定要看 P99）**

```promql
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, service))
```

**④ 饱和度**

```promql
# 连接池使用率
sum(active_connections) by (pool) / sum(max_connections) by (pool)
# 队列深度
sum(queue_depth) by (queue)
```

**"饱和度"是最容易被忽略但最关键的**（资源快耗尽时其他指标还正常）。

### 变量与下钻

```
顶部变量：service / instance / env
面板查询里引用 $service
```

**下钻链路**：

```
服务看板 → 点"错误率高" → 跳到诊断看板（带 service 变量）
→ 点某个实例 → 跳到日志（带 trace_id 查询）
```

**"能一跳到底"** 才能把 MTTR 压下来。

### 五个"看板很多但没人看"的原因

**① 面板太多（50 个）**

```
找信息要滚动三屏 → 值班时不用
→ 服务看板 ≤ 12 个面板
```

**② 只有"技术指标"，没有"用户视角"**

```
CPU 50% 说明不了"用户有没有受影响"
→ 顶部必须是 SLO 类指标
```

**③ 时间范围/步长不统一**

```
有的 5m、有的 1h → 同一屏上"趋势"对不上
```

**④ 没有阈值标注**

```
曲线很好看，但"多少算异常"写在文档里没人看
→ 面板加 threshold 颜色
```

**⑤ 看板是"一次性生成的"**

```
复制别人的 JSON，字段对不上 → 全是 no data
→ 看板要跟代码一起维护（Grafonnet/Jsonnet 或版本化 JSON）
```

### "no data" 的常见原因

```
① 指标名写错（Prometheus 里不存在）
② label 值不匹配（instance 带了端口）
③ 时间范围没有数据（服务刚重启）
④ 步长太大（短窗口数据被压平）
```

**排查方式**：

```
先在 Prometheus 的 Graph 页面跑同样的查询 → 确认有数据
再贴到 Grafana（排除看板本身的问题）
```

### 一个"值班能用"的看板清单

```
□ SLO 概览（可用性/延迟/错误率/QPS）
□ 错误 TopN（按服务/接口）
□ 延迟分位（P50/P90/P99）
□ 饱和度（连接池/队列/线程池）
□ 依赖健康（DB/Redis/MQ/下游）
□ 发布标记（annotation：版本/变更时间）
□ 告警状态面板（当前 firing 的告警）
```

**"发布标记"** 极其有用（"这个尖峰是不是刚发布引起的"）。

### annotation 的用法

```bash
curl -X POST http://grafana:3000/api/annotations \
  -H "Content-Type: application/json" \
  -d '{"text":"deploy v1.2.3","tags":["deploy","prod"]}'
```

**在 CI 的部署步骤里调用**，看板上就会出现竖线标记。

### 检查清单

```
□ 区分服务/诊断/业务三类看板
□ 服务看板顶部是 SLO 四指标
□ 看 P99（不只看平均）
□ 有饱和度面板
□ 有依赖健康
□ 有发布 annotation
□ 变量统一下钻
□ 面板数量克制（≤12）
□ 阈值/颜色标注
□ 看板版本化维护
□ 每个面板先验证"有数据"
```
