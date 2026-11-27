---
title: PromQL 速查
summary: 指标类型、selector、rate/irate、常用表达式模板、告警规则与降噪，一页装下日常调面板和写规则的姿势。
group: 监控
order: 9
tags: [Prometheus, PromQL, 监控]
---

## 基础语法

```promql
metric_name{label="value", label2=~"a|b", label3!="x"}   # 瞬时向量
metric_name{job="api"}[5m]                                # 区间向量（只能用于 rate/increase 等函数）
metric_name offset 1d                                     # 昨天同一时刻
metric_name @ 1700000000                                  # 指定时间戳（实验特性）
```

正则：`=~` 全匹配（不是包含），`!~` 取反。匹配"包含"要写 `=~".*api.*"`。

## 四种指标

| 类型 | 特征 | 用法 |
| --- | --- | --- |
| Counter | 只增 | `rate()` / `increase()` |
| Gauge | 可增可减 | 直接算，或 `avg_over_time()` |
| Histogram | `_bucket` + `le` | `histogram_quantile()` |
| Summary | `quantile` label | 直接取 |

## 速率函数

```promql
rate(x[5m])        # 每秒平均增长速率（推荐）
irate(x[1m])       # 最后两点瞬时速率（看突刺）
increase(x[1h])    # 区间内增量（适合"这小时报了多少错"）
delta(x[1h])       # Gauge 的差值
```

`rate` 窗口至少是抓取间隔的 4 倍。

## 常用模板

```promql
# QPS
sum by (path) (rate(http_requests_total[5m]))

# 5xx 比例
sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))

# P99 延迟
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))

# CPU 使用率
100 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100

# 内存使用率
100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

# 磁盘使用率（排除虚拟文件系统）
100 * (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"})

# 实例存活
sum(up{job="api"}) / count(up{job="api"})

# 同比（对比昨天同一时刻）
sum(rate(http_requests_total[5m])) - sum(rate(http_requests_total[5m] offset 1d))

# Top 5 慢接口
topk(5, sum by (path) (rate(http_request_duration_seconds_sum[5m])) / sum by (path) (rate(http_request_duration_seconds_count[5m])))
```

## 聚合

```promql
sum(...)          # 求和
avg(...)          # 平均
max / min(...)    # 极值
count(...)        # 序列条数
stddev(...)       # 标准差
sum by (label) (...)       # 按 label 分组
sum without (instance) (...)  # 除某 label 外全保留
```

`by` 与 `without` 不能同时用。

## 时间窗口函数

```promql
avg_over_time(x[1h])
max_over_time(x[1h])
min_over_time(x[1h])
quantile_over_time(0.95, x[1h])
absent(x{job="api"})            # 序列完全消失时报警
changes(x[1h])                  # 变化次数
resets(x[1h])                   # Counter 重置次数（进程重启）
```

`absent()` 是"服务彻底不见了"的兜底告警，比 `up == 0` 更早发现。

## 告警规则

```yaml
- alert: HighErrorRate
  expr: sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05
  for: 5m
  labels: { severity: page }
  annotations:
    summary: "5xx 比例 {{ $value | humanizePercentage }}"
```

必带三样：`for`（防抖）、`severity`（分流）、`runbook`（处置入口）。

## 记录规则

```yaml
- record: job:http_requests:rate5m
  expr: sum by (job) (rate(http_requests_total[5m]))
```

面板引用记录序列，查询从秒级降到毫秒级。

## 校验

```bash
promtool check rules rules/*.yml
promtool test rules test.yml
promtool query instant http://localhost:9090 'up{job="api"}'
```

## 常见坑

- `rate()` 算出 0：窗口太短或序列刚出现（不足两个点）。
- 图断线：抓取失败、`up==0`、label 被 relabel 删掉。
- 分位数为 NaN：Histogram 桶里没有足够样本，或没 `sum by (le)`。
- 内存爆：查询跨度过大（用记录规则预聚合）。
- `count()` 与 `count_over_time()` 不是一个东西，前者数序列数，后者数样本数。
