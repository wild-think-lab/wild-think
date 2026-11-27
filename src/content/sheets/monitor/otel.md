---
title: OpenTelemetry 速查
summary: Collector 三段式配置、常用 processor 顺序、自身指标、tail sampling 与排障判据。
group: monitor
order: 1
tags: [OpenTelemetry, 可观测, 采集]
---

### 三段式

```yaml
receivers:   # 收
processors:  # 处理
exporters:   # 发
service:
  pipelines:
    traces: {}
    metrics: {}
    logs: {}
```

### 常用 receiver

```yaml
otlp:
  protocols: {grpc: {endpoint: 0.0.0.0:4317}, http: {endpoint: 0.0.0.0:4318}}
prometheus:
  config: {scrape_configs: [{job_name: self, static_configs: [{targets: [localhost:8888]}]}]}
filelog:
  include: [/var/log/*.log]
  start_at: end
```

### 常用 processor 顺序

```
1) memory_limiter   防 OOM（必须最先）
2) batch            聚合
3) resource/attributes 打标签
4) tail_sampling    采样（保留错误/慢）
5) filter/transform 过滤/改写
```

### 常用 exporter

```yaml
otlphttp:
  endpoint: http://tempo:4318
prometheusremotewrite:
  endpoint: http://prometheus:9090/api/v1/write
loki:
  endpoint: http://loki:3100/loki/api/v1/push
debug:
  verbosity: detailed
```

### 采样策略

```yaml
tail_sampling:
  decision_wait: 10s
  policies:
    - {name: errors, type: status_code, status_code: {status_codes: [ERROR]}}
    - {name: slow, type: latency, latency: {threshold_ms: 500}}
    - {name: pct, type: probabilistic, probabilistic: {sampling_percentage: 5}}
```

### 自身指标（:8888/metrics）

```bash
curl -s localhost:8888/metrics | grep otelcol_
```

```
otelcol_receiver_accepted_spans      收了多少
otelcol_exporter_send_failed_spans   发失败（后端问题）
otelcol_processor_batch_batch_send_size  批大小
otelcol_process_memory_rss           内存
```

### 判据表

| 现象 | 首查 |
| --- | --- |
| 后端查不到数据 | exporter send_failed |
| 日志被当指标丢掉 | pipeline 是否混了 |
| 无法按服务过滤 | resource attributes 缺 service.name |
| 内存涨 | memory_limiter 是否在最前 |
| 错误样本很少 | 采样把错误也采掉了 |

### 坑

```
① memory_limiter 放后面 → 先爆内存
② 三条 pipeline 合并 → 类型错乱
③ 采样无"保留错误"策略
④ Collector 无监控（自己挂了不知道）
⑤ SDK 与 Collector 版本不匹配
```
