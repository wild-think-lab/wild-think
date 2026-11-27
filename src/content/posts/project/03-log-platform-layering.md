---
title: 日志平台怎么分层：从一台机器到一百台机器
description: 采集、传输、存储、查询、告警五层各管什么，ELK 与 Loki 的取舍，以及"日志没人看"这个真问题怎么解决。
date: 2022-05-19
tags: [日志, ELK, Loki, 可观测性, 运维平台]
---

### 先问一个更实际的问题

日志平台建了，一年后还没人查，那不如不建。所以先定**用途**：

| 用途 | 要求 | 选型倾向 |
| --- | --- | --- |
| 故障排查 | 能按 traceId 秒级查出全链路 | 结构化 + 索引 |
| 合规审计 | 保留 6 个月、不可篡改 | 冷存储 + 对象锁 |
| 安全分析 | 能跑规则匹配、异常检测 | 字段可检索 |
| 业务分析 | 能聚合统计 | 可接数仓 |

四个用途的存储成本差好几倍。**混在一起必然贵**，分层是最经济的做法。

### 五层结构

```
应用/系统日志
   ↓ 采集（Filebeat / Promtail / Fluent Bit / Vector）
消息缓冲（Kafka / Redis，可选）
   ↓ 解析与富化（Logstash / Vector）
存储与索引（ES / Loki / ClickHouse / 对象存储）
   ↓ 查询与展示（Kibana / Grafana）
   ↓ 告警（Alertmanager / 自建规则）
```

小规模（< 20 台）可以砍掉 Kafka，采集器直连存储。上百台、日志量 TB 级，缓冲层几乎必需——它能在存储故障时保住日志不丢。

### ELK 与 Loki 的差别

| 维度 | ELK（Elasticsearch） | Loki |
| --- | --- | --- |
| 索引 | 全文倒排，字段可检索 | 只索引标签，内容压缩存储 |
| 存储成本 | 高（通常 1:1.5 膨胀） | 低（可到 1:0.1） |
| 查询能力 | 强，聚合分析好 | 弱，适合"按标签+关键字"查 |
| 运维复杂度 | 高（分片、副本、JVM 调优） | 低（单二进制 + 对象存储） |
| 适用 | 需要复杂检索与聚合 | 排障为主、成本敏感 |

结论：**要分析能力选 ELK（或 ClickHouse 系），要便宜好用选 Loki。** 大多数中小团队的日志需求，Loki 已经够。

### 采集端该采集什么

```yaml
# promtail 示例（Loki 生态）
server:
  http_listen_port: 9080
positions:
  filename: /var/lib/promtail/positions.yaml
clients:
  - url: http://loki:3100/loki/api/v1/push
scrape_configs:
  - job_name: system
    static_configs:
      - targets: [localhost]
        labels:
          job: syslog
          host: ${HOSTNAME}
          __path__: /var/log/*.log
  - job_name: app
    static_configs:
      - targets: [localhost]
        labels:
          job: app
          env: prod
          __path__: /var/log/myapp/*.log
    pipeline_stages:
      - json:
          expressions:
            level: level
            trace: traceId
      - labels:
          level:
```

`labels` 的取舍是关键：**只把低基数（host、job、env、level）做成标签**。把 `traceId` 当标签会炸掉索引（基数爆炸），它应该留在日志内容里，靠全文搜索查。

### 存储与保留策略

- 热数据（7–14 天）：SSD，可快速查。
- 温数据（30–90 天）：HDD 或对象存储。
- 冷数据（180 天+，合规）：对象存储 + 生命周期策略（如 S3 lifecycle 转 GLACIER）。

按索引/按天分片，过期自动删除。**别用"定期 rm 文件"**，那会让查询层出现空洞。

### 你以为的坑，其实是这些

1. **日志格式不统一**：一半文本一半 JSON，结果只能全文搜，traceId 搜不到。统一结构化输出是前提。
2. **时间戳不一致**：应用用本地时间，系统用 UTC，跨时区排查时全乱。**统一 UTC 存储，展示时转本地**。
3. **日志量突增打爆存储**：一个 debug 开关忘关，一天写 200GB。必须设采集端限速与每日配额。
4. **敏感信息进日志**：手机号、身份证、token 明文写进日志 = 数据泄露。上线前必须有脱敏规则。
5. **没有 traceId**：跨服务排障只能靠"猜时间"，这是最贵的成本。

### 告警怎么做才有用

错误日志不是告警源，**错误率才是**。

```yaml
# 示例：5 分钟内 error 级别日志超过 100 条
- alert: HighErrorRate
  expr: sum(rate(loki_log_entries_total{level="error"}[5m])) > 1.7
  for: 10m
  labels: { severity: warning }
```

更有用的做法：

- 只对"新增的错误模式"告警（第一次出现才报，避免刷屏）。
- 关键业务日志缺失（该有心跳没有）→ 这才是致命信号。
- 告警必须能一键跳到查询页，且带时间窗，否则没人愿意点。

### 从零搭建的推荐顺序

1. 先统一日志格式（JSON，带 `time, level, service, host, traceId`）。
2. 单机 Loki + Promtail + Grafana 跑起来，一周内验证"能查"。
3. 加上保留策略与容量监控。
4. 接告警（错误率、日志断流）。
5. 规模上来后再考虑 Kafka 缓冲与冷热分层。

**别一上来就上 ES 集群**。三节点 ES 的运维成本，会吃掉你本可以用来写代码的所有时间。
