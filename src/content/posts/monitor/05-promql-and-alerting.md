---
title: PromQL 与告警规则：从"能看"到"能叫"
description: 四种指标类型、selector 与区间向量、rate 与 irate 的差别、聚合与分组、SLO 类告警的写法，以及告警噪音怎么降。
date: 2026-11-27
tags: [Prometheus, PromQL, 监控, 告警]
---

### 四种指标类型，先分清

| 类型 | 含义 | 例子 |
| --- | --- | --- |
| Counter | 只增不减 | `http_requests_total` |
| Gauge | 可上可下 | `node_memory_used_bytes` |
| Histogram | 分桶统计 | `http_request_duration_seconds_bucket` |
| Summary | 客户端算好的分位 | `rpc_duration_seconds{quantile="0.99"}` |

对 Counter **永远先 `rate()` 再用**，直接画原始值只会看到一条永远上升的线。

### selector 与区间

```promql
http_requests_total{job="api",status!="200"}          # 瞬时向量
http_requests_total{job=~"api|web"}[5m]               # 5 分钟区间向量
http_requests_total{status=~"5.."}[1h]                # 正则
```

`offset` 用来对比历史：`http_requests_total offset 1d`。

### rate 与 irate

```promql
# 5 分钟平均速率（推荐，抗抖动）
rate(http_requests_total[5m])

# 瞬时速率（只看最后两个点，适合看突刺，不适合告警）
irate(http_requests_total[1m])
```

`rate()` 的窗口至少要是抓取间隔的 4 倍，否则点数不够会算出诡异的 0。抓取 15s 时用 `[1m]` 最稳。

### 常用表达式模板

```promql
# 1. QPS（按接口）
sum by (path) (rate(http_requests_total[5m]))

# 2. 错误率
sum(rate(http_requests_total{status=~"5.."}[5m]))
/ sum(rate(http_requests_total[5m]))

# 3. P99 延迟（Histogram）
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))

# 4. CPU 使用率（排除 idle）
100 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100

# 5. 内存使用率
100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

# 6. 磁盘剩余
100 * node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes

# 7. 实例存活比例
sum(up{job="api"}) / count(up{job="api"})

# 8. 同环比（今天 vs 昨天同一时刻）
sum(rate(http_requests_total[5m]) offset 1d)
```

`histogram_quantile` 必须先 `sum by (le)` 再算，否则会把不同 label 的桶混在一起。

### 告警规则怎么写

```yaml
groups:
- name: api-slo
  rules:
  - alert: ApiHighErrorRate
    expr: |
      sum(rate(http_requests_total{job="api",status=~"5.."}[5m]))
      / sum(rate(http_requests_total{job="api"}[5m])) > 0.05
    for: 5m
    labels:
      severity: page
    annotations:
      summary: "API 5xx 比例 {{ $value | humanizePercentage }}"
      runbook: "https://wiki/runbook/api-5xx"

  - alert: InstanceDown
    expr: up{job="api"} == 0
    for: 2m
    labels:
      severity: page
```

三个关键字段：

- `for`：持续多久才发。**没有 `for` 的告警等于给噪音开门**。
- `labels.severity`：决定走哪条通知渠道（page 打电话，ticket 建单）。
- `annotations.runbook`：**告警必须带处置入口**，否则半夜收到告警的人只能猜。

### 降噪的五个手段

1. **加 `for`**：瞬时抖动不算问题。
2. **按业务影响排序**：`severity` 分三档，只有 page 才叫醒人。
3. **抑制（inhibit）**：主机挂了就别再发它上面 20 个服务的告警。

```yaml
inhibit_rules:
- source_matchers: [alertname="InstanceDown"]
  target_matchers: [severity=~"warning|ticket"]
  equal: [instance]
```

4. **分组（group_by）**：同一次故障的多个告警合成一条。

```yaml
route:
  group_by: [alertname, cluster]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
```

5. **消除"永远成立"的规则**：上线前用 `promtool check rules` 并观察一周历史数据，确认不会 24 小时持续 firing。

```bash
promtool check rules rules/*.yml
promtool test rules test.yml
```

### 记录规则：把贵的查询预先算好

```yaml
groups:
- name: precompute
  interval: 30s
  rules:
  - record: job:http_requests:rate5m
    expr: sum by (job) (rate(http_requests_total[5m]))
```

面板和告警都引用 `job:http_requests:rate5m`，查询瞬间完成，不再每次扫原始序列。

### SLO 类告警：按"预算消耗"叫，而不是按"指标超线"叫

```promql
# 30 天错误预算已消耗比例（目标 99.9%）
1 - (
  sum(rate(http_requests_total{status!~"5.."}[30d]))
  / sum(rate(http_requests_total[30d]))
) / 0.001
```

超过 1 就该停止发布、开始修，而不是等到月底看报表。这类告警的 `severity` 通常是 ticket 而非 page——它影响的是"发布节奏"，不是"现在挂了"。

### 排障：为什么图上是断的

- `up == 0`：抓取失败（网络、端口、认证）。
- 有目标但没数据：`metric_relabel_configs` 把 label 删了，或 `honor_labels` 冲突。
- 数据点间隔变大：抓取超时（`scrape_timeout` < 实际耗时）。
- 数值是 0：`rate()` 窗口太短，或 Counter 发生了重置（进程重启）——`rate()` 会自动处理重置，但会有一个尖峰。

### 一句话总结

PromQL 的核心是把 Counter 变成"速率"、把 Histogram 变成"分位"；告警的核心是**用 `for` 过滤抖动、用 runbook 给出下一步**。
