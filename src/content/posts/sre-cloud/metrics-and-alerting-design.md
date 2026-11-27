---
title: 监控指标设计：把"CPU 高"换成"用户受影响了吗"
description: 告警噪音的根因不是阈值定得不对，而是指标体系不完整——只有资源指标，没有服务指标。用 USE + RED 两套方法组合，再落到分级告警。
date: 2026-02-27
tags: [Prometheus, 监控, 告警, SRE, 指标设计]
---

"CPU 85%，告警"——这类告警 90% 是噪音，因为它没回答一个关键问题：**用户此刻受影响了吗**。

## 一、两套方法各有分工

| 方法 | 关注对象 | 指标 | 适合 |
| --- | --- | --- | --- |
| **USE** | 资源（CPU、内存、磁盘、网络） | Utilization / Saturation / Errors | 定位"哪里紧" |
| **RED** | 服务（请求/业务） | Rate / Errors / Duration | 判断"用户是否受影响" |

**告警应该主要由 RED 触发，USE 用于根因定位**。反过来就是"资源一抖就告警，用户毫无感知"。

## 二、先把四类黄金信号落地

对每个对外服务，至少采集：

1. **流量**：QPS / 请求速率（按路由维度）
2. **错误**：5xx 比例、业务错误码比例
3. **延迟**：P50 / P90 / P99，而不是平均值
4. **饱和度**：队列长度、连接池占用、线程池排队

Prometheus 里延迟用 histogram，别用平均值：

```yaml
# 应用侧暴露（示例：直方图桶要贴合业务 SLO，比如 50ms/100ms/300ms/1s）
http_request_duration_seconds_bucket{le="0.05"}
http_request_duration_seconds_bucket{le="0.1"}
http_request_duration_seconds_bucket{le="0.3"}
http_request_duration_seconds_bucket{le="1"}
```

```promql
# P99（按路由），这才是用户体感
histogram_quantile(0.99,
  sum by (route, le) (rate(http_request_duration_seconds_bucket[5m])
))

# 错误率
sum(rate(http_requests_total{status=~"5.."}[5m))
/
sum(rate(http_requests_total[5m))

# 资源饱和度：CPU 被限流的比例（容器场景最有用）
rate(container_cpu_cfs_throttled_periods_total[5m])
/
rate(container_cpu_cfs_periods_total[5m])
```

`container_cpu_cfs_throttled_periods` 比 `container_cpu_usage_seconds` 更有意义：**usage 高只说明忙，throttled 高说明被限流、真的在受影响**。

## 三、告警分级：P0–P3 与响应动作绑定

分级不是为了好看，是为了让值班人一眼知道该不该起床。

| 级别 | 判据 | 通知方式 | 响应 |
| --- | --- | --- | --- |
| P0 | 核心服务不可用 / 数据丢失风险 | 电话 + 短信 + 群 | 立即，5 分钟内 |
| P1 | 核心服务降级（错误率 >1%、P99 超 SLO 2 倍） | 电话 + 群 | 15 分钟内 |
| P2 | 非核心服务异常 / 资源接近瓶颈 | 群消息 | 工作时间内 |
| P3 | 趋势类（磁盘 7 天将满、证书 15 天到期） | 日报/工单 | 排期处理 |

写告警规则时，把"判据"写在注释里，避免后人乱调：

```yaml
groups:
  - name: svc-availability
    rules:
      # P1：5xx 比例超过 1% 持续 5 分钟（判据：错误率，不是资源）
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m)) by (job)
          /
          sum(rate(http_requests_total[5m)) by (job) > 0.01
        for: 5m
        labels: { severity: P1 }
        annotations:
          summary: "{{ $labels.job }} 5xx 比例 {{ $value | humanizePercentage }}"

      # P2：磁盘 4 小时内将满（趋势类，提前量而非当前值）
      - alert: DiskWillFillIn4Hours
        expr: predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[1h], 4*3600) < 0
        for: 10m
        labels: { severity: P2 }
```

`predict_linear` 是趋势告警的关键：**提前量告警比"已满告警"有用一个数量级**。

## 四、三个常见设计错误

1. **只监控资源，不监控业务**。CPU 70% 但订单失败率 30%，告警却一片安静。
2. **阈值拍脑袋**。阈值应从历史分位数与 SLO 推导：P99 长期 200ms，就把告警设在 400ms（2 倍 SLO），而不是"感觉 300ms 挺慢"。
3. **告警没有 owner**。没人负责的告警一定会被静音，静音掉的告警等于没有。

## 五、降噪的具体手法

- `for: 5m` 过滤瞬时抖动；对毛刺型指标用 `avg_over_time`。
- 用 `unless` 做抑制：同一服务的"错误率告警"抑制其"延迟告警"，避免一次故障刷 20 条。
- 维护期内静默（Alertmanager `silence`），并强制填写原因与时长。
- 每月统计：告警总数、有效处置数、平均确认时间。**有效率低于 50% 就该整组重写**。

> 一句话：**指标回答"发生了什么"，SLO 回答"是否算故障"。没有 SLO 的告警体系，只能靠音量说话。**
