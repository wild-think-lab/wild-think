---
title: OpenTelemetry Collector：把"三种信号"收进一条管道
description: 三条 pipeline（traces/metrics/logs）、processor 顺序、部署形态与五个"接了 OTel 还是查不到"的原因。
date: 2026-11-27
tags: [监控, 可观测, OpenTelemetry]
---

### 为什么需要 Collector

```
以前：每种信号一套 agent（日志一个、指标一个、链路一个）
现在：OTel Collector 三种信号统一收、统一处理、统一出口
```

**"应用只上报一次"** 是它的核心价值（vendor 无关）。

### 三条 pipeline

```yaml
receivers:  # 收（OTLP/jaeger/zipkin/prometheus/filelog）
processors: # 处理（batch/memory_limiter/attributes/resource）
exporters:  # 发（otlp/jaeger/prometheusremotewrite/loki/elasticsearch）
service:
  pipelines:
    traces:  {receivers: [otlp], processors: [batch], exporters: [otlp/jaeger]}
    metrics: {receivers: [otlp, prometheus], processors: [batch], exporters: [prometheusremotewrite]}
    logs:    {receivers: [filelog, otlp], processors: [resource], exporters: [loki]}
```

**"三条独立配置"** 是必须的（否则日志会被当指标处理）。

### 一个可用的最小配置

```yaml
receivers:
  otlp:
    protocols: {grpc: {endpoint: 0.0.0.0:4317}, http: {endpoint: 0.0.0.0:4318}}
  prometheus:
    config: {scrape_configs: [{job_name: self, static_configs: [{targets: [localhost:8888]}]}]}

processors:
  memory_limiter: {check_interval: 1s, limit_mib: 1024, spike_limit_mib: 256}
  batch: {}

exporters:
  debug: {verbosity: basic}
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write

service:
  pipelines:
    metrics: {receivers: [otlp, prometheus], processors: [memory_limiter, batch], exporters: [prometheusremotewrite]}
```

**`memory_limiter` 必须放在最前**（防 OOM）。

### processor 顺序有讲究

```
正确顺序（一般）
1) memory_limiter（最先，防爆）
2) batch（聚合成批）
3) 属性处理（attributes/resource/transform）
4) 采样/过滤（tail_sampling/filter）
5) exporters
```

**"先 batch 再 memory_limiter"** 会让内存先爆（batch 已经把数据堆起来了）。

### 部署形态

```
① Agent（每台/每节点，sidecar 或 DaemonSet）
② Gateway（集中接收、做采样与路由）
③ Agent → Gateway → 后端（推荐）
```

**"每个 Pod 一个 sidecar"** 成本高但隔离好；**"节点级 DaemonSet"** 更省（需要能读到容器日志）。

### 采样与降本

```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    policies:
      - {name: errors, type: status_code, status_code: {status_codes: [ERROR]}}
      - {name: slow, type: latency, latency: {threshold_ms: 500}}
      - {name: sample, type: probabilistic, probabilistic: {sampling_percentage: 5}}
```

**"全量存 trace"** 成本极高（保留错误 + 慢 + 5% 采样是常见组合）。

### 五个"接了 OTel 还是查不到"

**① 三条 pipeline 混了**

```
日志进了 metrics pipeline → 被当数值丢弃
```

**② resource/attribute 没打**

```
没有 service.name → 无法按服务过滤
```

**③ 采样把错误也采掉了**

```
probabilistic 5% → 错误样本只剩 5%
（要先"保留错误"再采样）
```

**④ exporter 端点错/认证失败**

```
Collector 日志里有 "export failed"
```

**⑤ SDK 版本与 Collector 不匹配**

```
老 SDK 发的 OTLP 新 Collector 收不了（看版本矩阵）
```

### 排障手段

```bash
# Collector 自身指标
curl localhost:8888/metrics | grep otelcol

# 关键指标
otelcol_receiver_accepted_spans
otelcol_exporter_send_failed_spans
otelcol_processor_batch_batch_send_size
```

**"send_failed > 0"** 说明后端有问题，不是采集问题。

### 检查清单

```
□ traces/metrics/logs 三条 pipeline 分开
□ memory_limiter 在最前
□ resource attributes 含 service.name
□ 采样策略保留错误与慢请求
□ Agent/Gateway 分层（可扩展）
□ 有 Collector 自身监控
□ 有 send_failed 告警
□ SDK 版本与 Collector 匹配
□ exporter 端点有认证
□ 有"本地 debug exporter"用于验证
```
