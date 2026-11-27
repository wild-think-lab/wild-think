---
title: 第 2 章 · 指标采集：Prometheus 的四个基本概念
module: 入门篇
summary: 拉取模型与推模型、指标类型、标签基数、抓取与保留，把"指标是怎么进来的"讲清楚，后面看板与告警才有根。
minutes: 20
---

### 拉取（pull）而不是推送（push）

Prometheus 主动去目标拉数据：

```
Prometheus  ──GET /metrics──▶  目标（node_exporter / 应用）
            ◀── 文本格式指标 ──
```

好处：Prometheus 知道"谁该在"，目标不响应就是有问题（自带存活探测）。

代价：目标必须能被 Prometheus 访问到（内网/防火墙要考虑）。

### 一个指标长什么样

```
http_requests_total{method="GET", status="200", handler="/api/order"} 1024
└─ 指标名 ────────────┘└─ 标签（label） ───────────────────────────────┘└ 值 ┘
```

三部分：

- **指标名**：说清"是什么"。
- **标签**：说清"哪一个"（维度）。
- **值**：数字（Prometheus 只存 float64）。

### 四种指标类型

```go
// ① Counter：只增不减，适合"累计数量"
prometheus.NewCounter(...)   // http_requests_total

// ② Gauge：可上可下，适合"瞬时值"
prometheus.NewGauge(...)     // 内存使用、连接数

// ③ Histogram：分桶统计，适合"延迟分布"
prometheus.NewHistogram(...) // 生成 _bucket/_sum/_count

// ④ Summary：分位数，客户端算好（少用，聚合会失真）
```

关键规则：**Counter 必须先 `rate()` 再用**。

```promql
# 错：直接看累计值
http_requests_total

# 对：每秒请求数
rate(http_requests_total[5m])
```

`rate()` 的正确用法：区间至少包含 2 个采样点，通常用 `[5m]`（抓取间隔 15s 时有 20 个点）。

### Histogram 怎么变成分位数

Histogram 产生三组序列：

```
http_request_duration_seconds_bucket{le="0.1"} 1200
http_request_duration_seconds_bucket{le="0.5"} 4800
http_request_duration_seconds_bucket{le="+Inf"} 5000
http_request_duration_seconds_sum 320.5
http_request_duration_seconds_count 5000
```

算 P95：

```promql
histogram_quantile(0.95,
  sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
```

**分桶边界要覆盖真实延迟范围**。默认 `[0.005, 0.01, 0.025, ..., 10]` 对大多数 Web 服务够用；如果 P99 落在最后一个桶（+Inf），说明边界不够，分位数会失真。

### 标签基数：最容易埋的雷

```yaml
# 好：维度有限
{method="GET", status="200", handler="/api/order"}

# 坏：高基数
{user_id="12345", request_id="abc-123", ip="10.0.0.5"}
```

每个不同的标签组合 = 一条独立的时间序列。加一个 `user_id` 标签，500 万用户 → 500 万条序列 → Prometheus 内存爆掉。

规则：**标签只放"取值有限（<50）」的维度**。高基数的信息放日志与链路，不要放指标。

### 抓取配置

```yaml
scrape_configs:
- job_name: node
  scrape_interval: 15s
  static_configs:
  - targets: ['10.0.0.1:9100', '10.0.0.2:9100']

- job_name: api
  metrics_path: /metrics
  static_configs:
  - targets: ['api-1:8080', 'api-2:8080']
```

参数怎么定：

| 参数 | 建议 |
| --- | --- |
| `scrape_interval` | 15s（默认）；高精度需求用 5s，但要算成本 |
| `scrape_timeout` | 不超过 interval 的一半 |
| `evaluation_interval` | 15s，与告警规则评估频率一致 |

### 保留与容量

```bash
# 估算：活跃序列数 × 采样点数 × 每样本字节
# 10000 序列 × (30 天 × 86400 / 15s) × ~1.5B ≈ 2.6GB（压缩前）
```

实际压缩后通常 1/10。留 30 天本地 + 长期存储（Thanos/VictoriaMetrics）是常见组合。

```yaml
storage:
  tsdb:
    retention.time: 30d
    retention.size: 50GB     # 到任一上限即删旧数据
```

### 应用怎么暴露指标

Go：

```go
http.Handle("/metrics", promhttp.Handler())
```

Node：

```js
const client = require('prom-client');
client.collectDefaultMetrics();
```

**自定义指标要少而准**，三条就够用：

```go
requestsTotal   // 计数（带 method/status/handler 标签）
requestDuration // Histogram
inFlight        // Gauge，处理中的请求数
```

不要为每个函数都埋点——指标越多，Prometheus 越慢，看板越没人看。

### 这一步的验收

```
□ /metrics 能返回 200 且格式正确
□ Prometheus targets 页面显示 UP
□ 能在 Prometheus 里查到 rate() 后的 QPS
□ 序列数在预期范围内（没被高基数标签污染）
```

### 练习

1. 给一个已有的服务加上 `requestsTotal` 与 `requestDuration` 两个指标，标签只带 method/status/handler。
2. 用 PromQL 算出该服务最近 5 分钟的 P95 延迟。
3. 故意加一个 `request_id` 标签，观察序列数的变化（理解基数问题）。
