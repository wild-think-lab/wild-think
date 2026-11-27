---
title: PromQL 实用手册：告警表达式写错，比不监控更危险
description: rate 用错窗口、increase 当成计数器、label 匹配写成全等——PromQL 的坑几乎都集中在"区间选择器"和"标签匹配"两处。给出一套能直接抄的告警表达式。
date: 2026-05-24
tags: [Prometheus, PromQL, 监控, SRE]
---

监控系统最贵的不是采集，是**误报**。一条 `rate()` 窗口写错的告警，能让值班同学在两周内学会忽略所有告警。

## 一、四个必须分清的概念

| 类型 | 例子 | 能否直接做聚合 |
| --- | --- | --- |
| Counter（只增） | `http_requests_total` | 必须 `rate()` / `increase()` 后才能求和 |
| Gauge（可增可减） | `node_memory_MemAvailable_bytes` | 可直接聚合 |
| Histogram | `http_request_duration_seconds_bucket` | 用 `histogram_quantile` |
| Summary | `http_request_duration_seconds_sum/count` | 相除得平均值 |

Counter 直接 `avg()` 得到的是"历史累计量的均值"，没有任何意义。这是新手最常见的第一类错误。

## 二、区间选择器：窗口至少是抓取间隔的 4 倍

```promql
# 抓取间隔 15s → 窗口用 1m 起步，别用 30s
rate(http_requests_total[1m])
```

`rate()` 需要区间内至少两个样本才能算斜率。窗口太小（如 `[30s]` 配 15s 抓取）只要有一次采集抖动，结果就是 `NaN` 或 0，告警开始抽风。

经验值：

- 抓取 15s → 告警用 `[2m]` 或 `[5m]`；
- 抓取 30s → 用 `[5m]`；
- 长周期趋势（日环比）才用 `[1h]` 以上，用 `rate` 而不是 `irate`。

`irate()` 只看最后两个点，适合"当下速率"，**不适合做告警**——它会把尖刺放大成告警。

## 三、延迟分位：histogram_quantile 的正确姿势

```promql
# P95 请求延迟（按接口分组）
histogram_quantile(
  0.95,
  sum by (le, path) (rate(http_request_duration_seconds_bucket[5m]))
)
```

三个细节：

1. `rate` 必须在 `sum` **里面**，顺序反了会先求和再算速率，分桶语义就废了；
2. `le` 标签必须留在 `by` 里，否则分位计算失去桶边界；
3. 分桶的上界要覆盖真实长尾（默认 `+Inf` 桶会让 P99 恒等于最大桶上界）。

## 四、一套可以直接用的告警表达式

**主机层**

```promql
# 内存可用低于 10%（排除缓存影响用 MemAvailable）
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10

# 磁盘将在 4 小时内写满（用线性预测，比固定阈值靠谱）
predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[6h], 4*3600) < 0

# CPU 满载持续 10 分钟
avg by (instance) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) > 0.9

# 负载高于核数 2 倍
node_load5 / count by (instance) (node_cpu_seconds_total{mode="idle"}) > 2
```

**应用层**

```promql
# 5xx 占比超 1%
sum(rate(http_requests_total{status=~"5.."}[5m))
  /
sum(rate(http_requests_total[5m])) > 0.01

# 某接口 P99 超过 800ms
histogram_quantile(0.99, sum by (le, path) (rate(http_request_duration_seconds_bucket[5m]))) > 0.8

# 队列积压持续增长
deriv(queue_length[10m]) > 0
```

**可用性**

```promql
# 实例掉线（连续 3 分钟无数据，配 absent() 更稳）
absent(up{job="api"} == 1)
```

`absent()` 只能在**整个向量为空**时触发，用于"target 彻底消失"；单个实例掉线用 `up == 0`，但要配 `for: 3m` 防抖。

## 五、标签匹配的三个陷阱

```promql
# 1. PromQL 的正则是"全匹配"，不是"包含"
{job=~"api"}          # 只匹配 job 恰为 api 的，安全
{job=~"api.*"}        # 会匹配 api-gateway、api-v2，也匹配 api 本身
{job=~"api-.*"}       # 想只看派生服务就这样写

# 2. 忽略环境标签，把多个环境混在一起算
sum(rate(http_requests_total[5m]))              # dev、staging、prod 全算进来
sum by (env) (rate(http_requests_total[5m]))    # 显式分组，告警才能定位

# 3. 用 != 过滤反而扩大集合
{status!="200"}       # 会包含 301、404、5xx，通常不是你要的
{status=~"5.."}       # 明确范围
```

第三点最隐蔽：`status!="200"` 在告警表达式里常被当成"错误率"，实际上把 304 缓存命中也算了进去，错误率虚高十倍。

## 六、告警规则工程

```yaml
groups:
  - name: host
    interval: 30s
    rules:
      - alert: HostDiskFillingUp
        expr: predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[6h], 4*3600) < 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.instance }} {{ $labels.mountpoint }} 预计 4 小时内写满"
          runbook: "https://wiki.example.com/runbook/disk"
```

三条硬规则：

1. **每条告警必须有 `for`**（除极端 P0），否则抖动会淹没页面；
2. **必须有 runbook 链接**，否则接手的人只能重启服务；
3. **severity 分层不超过三级**（critical/warning/info），级别越多越没人当真。

## 七、验证告警的方法

写完不要直接上线，用 `promtool` 做单元测试：

```bash
promtool test rules test.yml
```

```yaml
rule_files: [alerts.yml]
evaluation_interval: 1m
tests:
  - interval: 1m
    input_series:
      - series: 'node_filesystem_avail_bytes{instance="a",mountpoint="/",fstype="ext4"}'
        values: '1000 900 800 700 600 500'
    alert_rule_test:
      - eval_time: 10m
        alertname: HostDiskFillingUp
        exp_alerts:
          - exp_labels: {severity: warning, instance: a, mountpoint: /, fstype: ext4}
```

这是唯一能在上线前抓到"表达式永远不触发"或"永远触发"的手段。

> 一句经验：**告警表达式写完先在 Grafana 里跑 24 小时**，确认它在该响的时候响、不该响的时候安静。上线前能省下的误报，比多写十条指标更有价值。
