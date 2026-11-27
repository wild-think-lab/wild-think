---
title: 告警治理：把 300 条告警砍到 30 条可行动的
description: 四个降噪手段、告警分级的设计、为什么"加 for 5m"能去掉一半噪音，以及一份可以直接套用的告警规则模板。
date: 2025-04-03
tags: [监控, 告警, SRE]
---

### 现状通常是这样的

```
每天 300 条告警
值班的人看一眼就划掉
真有故障时，没人注意到那一条
```

**告警的价值 = 它引发行动的概率**。不能引发行动的都是噪音。

### 先做一次审计

```promql
# 过去 7 天，每条告警规则触发了多少次
# 从 Alertmanager 的指标里看
sum by (alertname) (increase(alertmanager_alerts_received_total[7d]))
```

**分类处理**：

| 触发次数 | 处置 |
| --- | --- |
| 0 次（7 天） | 要么阈值太松，要么该删 |
| 1–5 次 | 健康 |
| > 20 次 | 噪音源，必须处理 |

**"从没触发过"的告警也要审视**：它可能永远不会触发（写错了），也可能阈值太松（该发现的问题没发现）。

### 四个降噪手段

**① 加 `for`（最简单有效）**

```yaml
- alert: HighCPU
  expr: avg(rate(node_cpu_seconds_total{mode!="idle"}[5m])) by (instance) > 0.9
  for: 10m          # 持续 10 分钟才告警
```

**为什么有效**：

```
很多"尖刺"是正常的（编译、备份、定时任务）
持续时间过滤掉了绝大多数瞬时波动
```

**经验**：**加上 `for: 5m` 通常能去掉 50% 的噪音**。

**② 分级（severity）**

```yaml
labels:
  severity: warning    # 或 critical
```

**分级原则**：

```
critical：用户已经受影响，必须立刻处理（电话/短信）
warning ：可能将要受影响，工作时间处理（IM/邮件）
info    ：记录，不通知人（看板/日报）
```

**"所有告警都发到同一个群"是噪音的根源**。

**③ 抑制（inhibit）**

```yaml
inhibit_rules:
- source_matchers: [severity="critical"]
  target_matchers: [severity="warning"]
  equal: [instance]
```

**含义**：同一实例已经有 critical 告警了，就抑制它的 warning，避免"一个故障引发 30 条告警"。

**典型场景**：

```
节点挂了 → 该节点上 20 个服务全部告警
→ 只保留"节点不可达"这一条，抑制其他
```

**④ 分组（group）**

```yaml
route:
  group_by: [alertname, cluster]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
```

**含义**：同类告警在 30 秒内合并成一条；同一告警 4 小时才重复提醒一次。

**没有 `repeat_interval` 的后果**：一个持续 3 天的告警每 5 分钟发一次（360 条）。

### 告警规则应该"看现象"而不是"看资源"

**对比**：

```yaml
# 差：资源型（CPU 高不代表用户受影响）
- alert: HighCPU
  expr: avg(rate(node_cpu_seconds_total{mode!="idle"}[5m])) by (instance) > 0.9

# 好：现象型（用户真的受影响）
- alert: HighErrorRate
  expr: |
    sum(rate(http_requests_total{code=~"5.."}[5m]))
      / sum(rate(http_requests_total[5m])) > 0.05
  for: 2m
```

**资源型作为"预警"（warning），现象型作为"告警"（critical）**。

### 一份可套用的规则集

```yaml
groups:
- name: service-slo
  rules:
  # 可用性：5xx 比例
  - alert: ServiceErrorRateHigh
    expr: |
      sum by (service) (rate(http_requests_total{code=~"5.."}[5m]))
        / sum by (service) (rate(http_requests_total[5m])) > 0.05
    for: 2m
    labels: { severity: critical }
    annotations:
      summary: "{{ $labels.service }} 5xx 率 {{ $value | humanizePercentage }}"
      runbook: "https://wiki/runbook/error-rate"

  # 延迟：P99 超 SLO
  - alert: ServiceLatencyHigh
    expr: |
      histogram_quantile(0.99,
        sum by (service, le) (rate(http_request_duration_seconds_bucket[5m]))
      ) > 0.5
    for: 5m
    labels: { severity: warning }

  # 资源：磁盘
  - alert: DiskWillFillIn4h
    expr: |
      predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[6h], 4*3600) < 0
    for: 15m
    labels: { severity: warning }

  # 资源：内存
  - alert: NodeMemoryPressure
    expr: |
      (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) < 0.1
    for: 10m
    labels: { severity: warning }

  # 进程：重启
  - alert: PodRestarting
    expr: increase(kube_pod_container_status_restarts_total[15m]) > 2
    for: 5m
    labels: { severity: warning }
```

**`predict_linear` 的用法很实用**：它预测"按当前趋势，4 小时后磁盘会满"，让你提前处理（而不是等它满）。

### 每条告警必须有的三样东西

```
① summary：人能看懂的一句话（含当前值）
② runbook：出问题去看哪（链接）
③ severity：该不该半夜叫人
```

**没有 runbook 的告警**：值班的人收到了但不知道做什么 → 逐渐被忽略。

### "值班被叫醒"的规则

```
只有 critical 才打电话
critical 的条件：用户已经受影响（5xx 率高、核心功能不可用）
```

**"节点 CPU 90%"绝不该打电话**。

### 检查清单

```
□ 做过告警审计（按触发次数排序）
□ > 20 次的规则都处理过
□ 关键告警都有 for（≥ 5m）
□ 有 severity 分级（不同通知渠道）
□ 有 inhibit（故障时的连锁告警被抑制）
□ 有 group + repeat_interval
□ 优先"现象型"告警（用户受影响）
□ 资源型只做 warning
□ 每条有 summary + runbook + severity
□ 只有 critical 才电话
```
