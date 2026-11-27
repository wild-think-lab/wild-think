---
title: 主动探测监控：黑盒监控补上"用户视角"的盲区
description: 白盒与黑盒的分工、拨测的四种方式、多节点探测的必要性、告警与 SLO 的关系、以及"探测本身挂了"怎么避免。
date: 2026-11-27
tags: [监控, 拨测, 黑盒, SLO]
---

### 白盒看"内部状态"，黑盒看"用户能不能用"

| | 白盒（Blackbox 的反面） | 黑盒（拨测/合成监控） |
| --- | --- | --- |
| 数据来源 | 应用自己上报（指标、日志、trace） | 外部主动发起请求 |
| 能看到 | CPU、QPS、错误码、慢查询 | 能不能打开、多快、内容对不对 |
| 盲区 | DNS 解析错、证书过期、LB 配错、CDN 回源失败 | 内部原因（只知道"不行"，不知道"为什么"） |

典型事故：所有内部指标都是绿的，但**证书过期了**——白盒完全看不到，用户全打不开。这就是黑盒存在的意义。

### 拨测的四种方式

**① HTTP 探测**

```yaml
# Prometheus blackbox_exporter 配置
modules:
  http_2xx:
    prober: http
    timeout: 10s
    http:
      preferred_ip_protocol: ip4
      valid_status_codes: [200]
      method: GET
```

```yaml
scrape_configs:
- job_name: blackbox-http
  metrics_path: /probe
  params: { module: [http_2xx] }
  static_configs:
  - targets:
    - https://app.example.com/healthz
    - https://api.example.com/v1/ping
  relabel_configs:
  - source_labels: [__address__]
    target_label: __param_target
  - source_labels: [__param_target]
    target_label: instance
  - target_label: __address__
    replacement: 127.0.0.1:9115
```

**② TCP 端口探测**：验证"端口是否可连"，区分"服务挂了"和"网络不通"。

**③ ICMP 探测**：只测网络可达与延迟，注意很多云厂商禁 ping，结果不可信。

**④ 业务级探测（最有效）**：不只 ping `/healthz`，而是走一遍真实流程：

```
登录（用测试账号）→ 查询列表 → 提交一笔测试订单（标记为 test）→ 校验返回
```

它能发现"healthz 返回 200 但业务逻辑全错"的情况——这类问题白盒与简单 HTTP 探测都发现不了。

### 多节点探测：单点探测会说谎

从一台机器探测，"不通"可能是探测机自己的网络问题。所以至少三个来源：

```
① 云上不同可用区的探测机
② 办公网一台（模拟内网用户）
③ 第三方拨测服务（模拟真实公网用户，覆盖多地运营商）
```

判据：

- **三个来源都不通** → 服务真的挂了。
- **只有办公网不通** → 公司出口或 DNS 问题。
- **只有某地运营商不通** → CDN/线路问题。

单点探测的告警噪音能到 30% 以上，多点是降噪的最有效手段。

### 告警规则怎么写才不吵

```yaml
- alert: EndpointDown
  expr: probe_success{job="blackbox-http"} == 0
  for: 3m
  labels: { severity: page }
```

三个要点：

1. **`for` 至少 3 分钟**：单次抖动不算。
2. **按"多点同时失败"判断**，而不是单点：

```promql
# 同一目标，多数探测点失败才算真故障
sum by (instance) (probe_success == 0) / count by (instance) (probe_success) > 0.6
```

3. **分级**：单点失败 → ticket；多点失败 → page；探测超时但能连 → warning。

### 与 SLO 的关系

拨测结果是**用户体验的直接证据**，所以它能直接支撑 SLO：

```
可用性 = 成功探测次数 / 总探测次数
```

比"应用自报 200 的比例"更可信，因为它是从外部视角测的。

```promql
# 30 天可用性（按拨测成功率）
sum_over_time(probe_success{job="blackbox-http"}[30d])
/ count_over_time(probe_success{job="blackbox-http"}[30d])
```

### 探测本身的三个陷阱

**① 探测机自己挂了**

- 用 `absent()` 或"探测机心跳"监控探测机。
- 至少两台探测机，互相校验。

**② 探测请求被当成真实流量**

- 遇到限流或 WAF 拦截，导致"探测失败但服务正常"。
- 解法：探测源 IP 加白名单，或走独立域名/独立路径。

**③ 探测增加成本**

- 每秒一次全流程探测，会真的产生订单。
- 解法：低频（1 分钟）、测试数据标记、独立测试账号。

### 该探的五个点

| 探测对象 | 频率 | 判据 |
| --- | --- | --- |
| 首页（含 DNS + TLS） | 1 分钟 | 200 且响应时间 < 2s |
| 核心 API | 1 分钟 | 200 且 < 500ms |
| 登录流程 | 5 分钟 | 能拿到 token |
| 支付回调（沙箱） | 5 分钟 | 返回成功 |
| 证书有效期 | 1 天 | 剩余 > 30 天 |

最后一条用 `probe_ssl_earliest_cert_expiry` 就能做，**比任何人工巡检都可靠**：

```promql
probe_ssl_earliest_cert_expiry - time() < 86400 * 30
```

### 一句话总结

白盒告诉你"系统觉得自己怎么样"，黑盒告诉你"用户实际能不能用"。两者都要，而**证书、DNS、LB 这三类问题只有黑盒能发现**。
