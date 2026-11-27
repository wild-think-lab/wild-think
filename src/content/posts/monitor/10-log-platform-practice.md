---
title: 从零搭一套"能用的"日志平台：采集、存储、查询、告警
description: 四种采集方式的取舍、索引与存储的成本控制、查询为什么慢、以及"日志平台没人用"的三个原因。
date: 2026-11-27
tags: [日志, ELK, Loki, 可观测性]
---

### 四个环节

```
采集（Filebeat/Promtail/Fluent Bit）
  ↓
存储与索引（Elasticsearch / Loki / ClickHouse）
  ↓
查询（Kibana / Grafana）
  ↓
告警（基于日志内容的规则）
```

**最常见的问题是"只做了前两步"**：日志收上来了，但没人查、没人告警。

### 采集方式的选择

| 方式 | 适用 | 代价 |
| --- | --- | --- |
| 应用直接写日志文件 + Filebeat | 传统部署 | 要维护文件轮转 |
| stdout + 容器日志驱动 + Promtail | K8s | 日志量大时 IO 高 |
| 应用直接推（Fluent Bit/syslog） | 集中式 | 应用要改代码 |
| 边车（sidecar） | 特殊格式 | 每个 Pod 多一个容器 |

**K8s 推荐**：应用写 stdout → Promtail（DaemonSet）采集 `/var/log/containers/*.log` → Loki。

Loki 的好处：**不建全文索引，只索引标签**，成本是 ES 的 1/5–1/10。

### 索引设计的成本陷阱

Elasticsearch 的存储膨胀来自三个地方：

```
① 每个字段都建索引（text 字段会分词 + 倒排）
② 副本（默认 1 副本 = 双倍空间）
③ 保留期太长（30 天以上的日志很少有人查）
```

优化：

```json
PUT _ilm/policy/logs-policy
{
  "policy": {
    "phases": {
      "hot":  { "actions": { "rollover": { "max_size": "50gb", "max_age": "1d" } } },
      "warm": { "min_age": "3d", "actions": { "shrink": {}, "forcemerge": { "max_num_segments": 1 } } },
      "delete": { "min_age": "14d", "actions": { "delete": {} } }
    }
  }
}
```

字段映射要点：

```
- 明确不需要检索的字段设 "index": false
- 日志原文用一个 text 字段（不要拆成一堆字段）
- 标签类字段用 keyword
```

**"日志总量 1TB/天但只查最近 3 天"** 是最常见的浪费。

### 查询为什么慢

| 现象 | 原因 |
| --- | --- |
| 时间范围大就慢 | 要扫很多分片 |
| 模糊搜索慢 | 没有索引/分词不匹配 |
| 加了条件反而更慢 | 条件字段没索引，走了全扫 |
| 查询超时 | 分片太多（每分片开销叠加） |

Loki 的查询要点：

```logql
{namespace="prod", app="api"} |= "error" | json | line_format "{{.msg}}"
```

**先缩小标签范围，再做全文过滤**。Loki 的标签相当于索引，全文匹配是暴力扫。

### 告警：让日志"有用"

三类有价值的日志告警：

```
① 错误数量突增（不是单条）
   sum(count_over_time({app="api"} |= "ERROR" [5m])) > 50

② 特定关键错误（认证失败、支付异常）
   {app="api"} |= "payment failed"

③ 日志中断（服务挂了没日志）
   absent_over_time({app="api"}[10m])
```

**不要对每条 ERROR 告警**：会被淹没，然后被静音，然后彻底失效。

### "日志平台没人用"的三个原因

**① 查不到想查的**

```
开发想问："这个订单为什么失败？"
日志里没有 order_id，或者字段名不统一（orderId / order_id / oid）
```

对策：**统一结构化日志的字段规范**（至少 trace_id、user_id、service、level）。

**② 不知道去哪查**

对策：每个服务的 Grafana/Kibana 面板里放一个"日志入口"链接，带上该服务的标签过滤。

**③ 查了也不知道看什么**

对策：常见故障的"查询模板"写进 runbook，例如"5xx 突增时先查这个查询"。

### 结构化日志的最小规范

```json
{
  "ts": "2026-11-27T10:12:33.123+08:00",
  "level": "error",
  "service": "order-api",
  "trace_id": "a1b2c3d4e5",
  "user_id": "u_1024",
  "msg": "payment callback failed",
  "error": "timeout after 5000ms",
  "extra": {"order_id": "o_8891", "channel": "alipay"}
}
```

四件事必须做：

```
① 时间是 ISO8601 带时区（别用本地时间字符串）
② 有 trace_id（能串起整条链路）
③ level 用标准值（debug/info/warn/error）
④ 关键业务 ID 在固定字段里
```

有了这四条，日志平台才"能查"。

### 一个低成本方案（中小规模）

```
采集：Promtail（DaemonSet）
存储：Loki（单机或 simple-scalable）
查询：Grafana
告警：Grafana Alerting / Loki ruler
保留：14 天热数据 + 归档到对象存储 90 天
```

成本对比（每天 100GB 日志、保留 14 天）：

| 方案 | 存储需求（约） |
| --- | --- |
| ELK（1 副本 + 索引） | 3–4 TB |
| Loki（压缩 + 无全文索引） | 400–600 GB |

### 检查清单

```
□ 采集覆盖所有服务（含边车/init 容器）
□ 日志结构化（有 trace_id 与统一字段）
□ 有保留期策略（ILM/retention），不是无限增长
□ 索引字段精简（不需要检索的不建索引）
□ 有三类告警（错误突增、关键错误、日志中断）
□ 每类常见故障有查询模板
□ 面板里有日志入口链接
□ 归档到对象存储（长期保留的低频需求）
```
