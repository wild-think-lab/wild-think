---
title: Grafana Loki 速查
description: 部署形态、LogQL 语法、标签设计、保留策略与常见排障。
summary: 从 promtail 采集到 LogQL 查询，一条链路看完。
group: monitor
order: 4
tags: [Loki, 日志, Grafana]
---

### 三个组件

```
loki       ：服务端（存储 + 查询）
promtail   ：采集代理（读日志 → 推给 loki）
grafana    ：查询界面（数据源指向 loki）
```

**单机（docker-compose）最小化**：

```yaml
services:
  loki:
    image: grafana/loki:3.0
    ports: ["3100:3100"]
    command: -config.file=/etc/loki/local-config.yaml
  promtail:
    image: grafana/promtail:3.0
    volumes:
    - /var/log:/var/log
    - ./promtail.yml:/etc/promtail/config.yml
  grafana:
    image: grafana/grafana:11.0
    ports: ["3000:3000"]
```

### promtail 采集配置

```yaml
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
- url: http://loki:3100/loki/api/v1/push

scrape_configs:
- job_name: system
  static_configs:
  - targets: [localhost]
    labels:
      job: syslog
      __path__: /var/log/*.log

  pipeline_stages:
  - regex:
      expression: '^(?P<ts>\S+) (?P<host>\S+) (?P<msg>.*)$'
  - timestamp:
      source: ts
      format: RFC3339
  - labels:
      host:
```

**K8s Pod 采集**：

```yaml
- job_name: pods
  kubernetes_sd_configs:
  - role: pod
  relabel_configs:
  - source_labels: [__meta_kubernetes_pod_label_app]
    target_label: app
  - source_labels: [__meta_kubernetes_namespace]
    target_label: namespace
  - source_labels: [__meta_kubernetes_pod_name]
    target_label: pod
```

### 标签设计（最重要）

```
✅ 低基数：app、namespace、env、level、job
❌ 高基数：request_id、user_id、ip、trace_id
```

**为什么**：

```
Loki 以"标签组合"为流（stream）单位
高基数标签 → 流数爆炸 → 内存与索引崩溃
```

**高基数字段放日志内容里，用过滤搜索**：

```logql
{app="api"} |= "trace_id=abc123"
```

### LogQL 三类操作

**① 流选择（必须）**

```logql
{app="api", env="prod"}
{namespace="prod"} |= "error"
```

**② 行过滤**

```
|= "text"      包含
!= "text"      不包含
|~ "regex"     匹配正则
!~ "regex"     不匹配
```

**③ 解析与过滤**

```logql
{app="api"} | json | level="error"
{app="api"} | logfmt | dur_ms > 1000
{app="api"} | pattern `<_> level=<level> msg=<msg>`
{app="api"} | regexp `(?P<code>\d{3})`
```

**`| json`** 会解析行内 JSON 并提取字段（这是最常用的结构化方式）。

### 指标查询（把日志当指标）

```logql
# 每秒日志条数
sum(rate({app="api"}[1m]))

# 错误率
sum(rate({app="api"} |= "level=error" [1m]))
/ sum(rate({app="api"}[1m]))

# 按服务分组
sum by (service) (rate({namespace="prod"} | json | level="error" [5m]))

# Top 错误消息（用 pattern 提取）
topk(5, sum by (msg) (count_over_time({app="api"} | json | level="error" [1h])))
```

**`rate(...)` 与 `count_over_time(...)` 的区别**：

```
rate           ：每秒速率（适合做曲线）
count_over_time：区间内总数（适合 Top-N）
```

### 常见查询示例

```logql
# 某 trace 的全链路
{namespace="prod"} |= "abc123"

# 慢请求
{app="order-api"} | json | duration_ms > 500 | line_format "{{.ts}} {{.msg}} {{.duration_ms}}"

# 排除健康检查
{app="api"} != "/healthz"

# 最近 10 分钟的错误，按时间倒序
{app="api"} |= "error" | json | level="ERROR"
```

**`line_format`** 可以重排输出（便于阅读）。

### 保留策略

```yaml
# loki 配置
limits_config:
  retention_period: 720h    # 30 天

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  delete_request_store: filesystem
```

**注意 3.x 起 retention 由 compactor 负责**（不再用 `table_manager`）。

**分层保留**（不同租户/服务不同期限）：

```yaml
limits_config:
  retention_stream:
  - selector: '{env="prod"}'
    priority: 1
    period: 720h
  - selector: '{env="dev"}'
    priority: 2
    period: 72h
```

### 存储后端

```
filesystem ：单机实验
S3/OSS     ：推荐（对象存储，成本低）
```

```yaml
storage_config:
  aws:
    s3: s3://region/bucket
    endpoint: s3.endpoint
    access_key_id: xxx
    secret_access_key: xxx
```

**"Loki 便宜"的关键就在这里**：日志块直接放对象存储。

### 排障

```bash
# loki 健康
curl -s localhost:3100/ready
curl -s localhost:3100/metrics | grep loki_

# 常见问题
① 查不到日志 → 检查 labels（标签写错最常见）
② 时间不对 → timestamp stage 没配或时区错
③ 内存高 → 高基数标签（检查 /metrics 的 streams 数）
④ 查询超时 → 时间范围太大或没加 |= 过滤
```

```bash
# 看流数量（高基数标签的直接指标）
curl -s localhost:3100/metrics | grep loki_ingester_streams
```

### 与 ELK 的取舍

| 需求 | Loki | ES |
| --- | --- | --- |
| 成本 | 低 | 高 |
| 全文检索 | 弱（只能 grep） | 强 |
| 结构化聚合 | 中 | 强 |
| 上手 | 易 | 中 |
| 大日志量 | 适合 | 存储压力大 |

**结论**：

```
按服务/实例定位日志、成本敏感 → Loki
需要"任意关键字搜 + 复杂聚合" → ES
两者可以并存（热数据 ES，冷数据 Loki）
```

### 坑

```
① 高基数标签 → 流爆炸（最致命）
② 时间戳格式/时区没对齐 → 查不到
③ 多行日志没合 → 堆栈被拆散
④ retention 没开 compactor → 磁盘只增不减
⑤ `|=` 放在最后 → 先全量扫再过滤（性能差）
⑥ 大时间范围 + 无过滤 → 查询超时
```

**"先选标签，再最早加过滤"是查询提速的关键**。
