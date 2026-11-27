---
title: 日志平台选型：ELK、Loki、ClickHouse 各自适合谁
description: 采集→传输→存储→查询四段的分工、索引与标签两种模型的差别、成本怎么算、以及"日志平台建成后没人查"的根因。
date: 2023-08-25
tags: [日志, ELK, Loki, ClickHouse, 可观测性]
---

### 四段结构

```
采集（agent） → 传输（buffer） → 存储（索引/列存） → 查询（UI/API）
Filebeat/Fluent Bit   Kafka/Redis     ES / Loki / CK      Kibana / Grafana
```

选型的本质是**存储与查询模型**的选择，采集侧基本都靠 Fluent Bit/Filebeat。

### 三种存储模型

| | Elasticsearch | Loki | ClickHouse |
| --- | --- | --- | --- |
| 索引方式 | 全文倒排索引 | 只索引标签（label） | 列存 + 跳过索引 |
| 查询能力 | 强（全文、聚合、复杂 query） | 弱（按标签过滤 + 正则） | 很强（SQL、聚合快） |
| 存储成本 | 高（索引膨胀 1.5–3 倍） | 低（压缩日志块） | 中低（列压缩好） |
| 写入成本 | 中 | 低 | 低 |
| 典型用途 | 全文检索、审计 | 结构化服务的日志聚合 | 大规模分析与报表 |

**判断口诀**：

- 需要"全文搜关键词、复杂聚合、字段级检索" → Elasticsearch。
- 只需要"按服务/级别/时间过滤，偶尔 grep" → Loki，省 5–10 倍成本。
- 日志量极大且要做统计（如错误趋势、慢请求归因） → ClickHouse。

### Loki 的关键认知：标签基数

Loki 只对 label 建索引，**label 设计错了会比 ES 还难用**。

```yaml
# 好：低基数标签
labels:
  service: order-api
  env: prod
  level: error

# 坏：把高基数字段当标签
labels:
  request_id: 2f8a...     # 每个请求都不同 → 索引爆炸
  user_id: 12345          # 同上
```

高基数标签会让 Loki 的索引与 ingester 内存暴涨，是 Loki 最常见的生产事故。

规则：**标签只放"取值有限（<100）」的维度**，其余都放进日志正文里靠 `|=` 过滤。

```logql
{service="order-api"} |= "traceId=2f8a"
```

### 采集侧：五个必配

```toml
# Fluent Bit 示例
[INPUT]
    Name              tail
    Path              /var/log/app/*.log
    Parser            json
    Tag               app.order
    Multiline         true

[FILTER]
    Name              modify
    Match             app.*
    Add               env prod
    Add               service order-api

[OUTPUT]
    Name              loki
    Match             app.*
    Host              loki.internal
    Labels            env, service
```

必配项：

1. **多行合并**：Java 堆栈不合并会被切成一行行碎片，排障时无法阅读。
2. **字段提取**：JSON 日志解析成结构化字段，否则只能正则。
3. **限速**：`Mem_Buf_Limit` + 磁盘缓冲，防止日志暴涨打爆下游。
4. **脱敏**：手机号、身份证在采集侧就替换，不要等进库再处理。
5. **本地磁盘缓冲**：网络抖动时不丢日志。

### 成本怎么算

以每天 500GB 原始日志、保留 30 天为例：

| 方案 | 存储需求（估） | 说明 |
| --- | --- | --- |
| ES 3 副本 + 索引 | ~45TB | 索引膨胀 + 副本 |
| ES 1 副本 + 冷热分层 | ~20TB | 热 7 天 SSD，冷 23 天 HDD |
| Loki（压缩块 + 对象存储） | ~4TB | 压缩率通常 10 倍以上 |
| ClickHouse | ~8TB | 列压缩，副本因子 2 |

省钱的三个动作：

1. **冷热分层**：热数据 SSD，冷数据对象存储/HDD。
2. **降副本**：日志不是账本，1 副本 + 备份到对象存储就够。
3. **采样与分级**：DEBUG 级别只在排障时开，平时 INFO；错误日志全留，访问日志采样。

### 查询体验决定平台生死

平台建成后没人用，通常是三个原因：

1. **查不到东西**：log 里没有 traceId，跨服务串不起来。
2. **太慢**：查 1 天数据要 40 秒。
3. **不知道查什么**：没有预置的"常用查询"入口。

解法：

- 日志格式统一（JSON + 固定字段：`ts/level/service/traceId/userId/msg`）。
- 提供"一键从告警跳到日志"的链接（Grafana 面板里配 explore 链接）。
- 预置 10 条高频查询（按服务、按 traceId、按错误级别、按慢请求）。

### 一条从告警到根因的路径

```
告警（Prometheus）→ 面板显示错误率飙升
   ↓ 点击面板右上角 "Logs"
Loki 查询 {service="order-api", level="error"} 最近 15 分钟
   ↓ 找到高频错误 + traceId
链路追踪（Jaeger/Tempo）按 traceId 查全链路
   ↓ 发现某下游 span 耗时 3s
回该下游服务的日志，按同一 traceId 查
```

关键：**traceId 必须在所有层都记录**（网关生成，透传到每个服务）。没有它，这条路径走不通。

### 落地顺序

| 阶段 | 做什么 |
| --- | --- |
| 1 | 统一日志格式（JSON + 固定字段），这一条比选型重要 |
| 2 | 单机 Loki + Grafana，先让"能查"跑起来 |
| 3 | 加 Kafka 缓冲，防止峰值打爆存储 |
| 4 | 冷热分层 + 保留策略 |
| 5 | 与告警、链路追踪打通 |
| 6 | 需要全文检索/审计时再上 ES |

**不要一开始就上 ELK 集群**：90% 的团队用不到全文检索，却要承担索引膨胀与运维复杂度。
