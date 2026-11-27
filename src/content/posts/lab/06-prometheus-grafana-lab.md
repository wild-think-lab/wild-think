---
title: 实验报告：Prometheus + Grafana + node_exporter 全家桶
description: 目的/环境/步骤/验证完整走一遍：装 node_exporter、配 Prometheus 抓取、加告警规则、接 Grafana 出图、接 Alertmanager 发通知，最后附排障清单。
date: 2022-05-02
tags: [监控, Prometheus, Grafana, 实验报告]
---

### 实验目的

在一台 4C8G 的 Linux 主机上搭起"采集 → 存储 → 展示 → 告警"的最小闭环，并验证四个关键指标：主机资源、服务存活、接口 QPS、接口 P99。

### 实验环境

| 角色 | 地址 | 组件 |
| --- | --- | --- |
| 监控机 | 192.168.1.30 | Prometheus、Grafana、Alertmanager |
| 被监控机 | 192.168.1.31 | node_exporter、demo 服务 |
| 系统 | Ubuntu 24.04 | 时钟同步已开启 |

前置检查：

```bash
timedatectl | grep synchronized        # 必须是 yes，时间不同步会导致图表错位
ss -lntp                               # 确认 9090/9100/3000/9093 没被占
```

### 步骤一：装 node_exporter

```bash
useradd --no-create-home --shell /usr/sbin/nologin node_exporter
curl -LO https://github.com/prometheus/node_exporter/releases/download/v1.9.0/node_exporter-1.9.0.linux-amd64.tar.gz
tar xf node_exporter-1.9.0.linux-amd64.tar.gz
install -m 0755 node_exporter-1.9.0.linux-amd64/node_exporter /usr/local/bin/
```

systemd：

```ini
# /etc/systemd/system/node_exporter.service
[Unit]
Description=Node Exporter
After=network.target

[Service]
User=node_exporter
ExecStart=/usr/local/bin/node_exporter \
  --collector.systemd \
  --collector.processes \
  --web.listen-address=:9100
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now node_exporter
curl -s localhost:9100/metrics | head -5
```

`--collector.systemd` 能采到 systemd unit 状态，对"服务挂了但机器还在"的告警很有用。

### 步骤二：装 Prometheus

```bash
curl -LO https://github.com/prometheus/prometheus/releases/download/v3.0.1/prometheus-3.0.1.linux-amd64.tar.gz
tar xf prometheus-3.0.1.linux-amd64.tar.gz -C /opt/
mv /opt/prometheus-3.0.1.linux-amd64 /opt/prometheus
mkdir -p /var/lib/prometheus
useradd --no-create-home --shell /usr/sbin/nologin prometheus
chown -R prometheus: /var/lib/prometheus
```

配置 `/opt/prometheus/prometheus.yml`：

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - rules/*.yml

alerting:
  alertmanagers:
  - static_configs:
    - targets: ['127.0.0.1:9093']

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ['localhost:9090']

  - job_name: node
    static_configs:
      - targets: ['192.168.1.31:9100']
        labels: { env: lab }

  - job_name: demo-api
    metrics_path: /metrics
    static_configs:
      - targets: ['192.168.1.31:8080']
```

启动参数：

```bash
/opt/prometheus/prometheus \
  --config.file=/opt/prometheus/prometheus.yml \
  --storage.tsdb.path=/var/lib/prometheus \
  --storage.tsdb.retention.time=15d \
  --web.enable-lifecycle
```

`--web.enable-lifecycle` 让改配置后能 `curl -X POST localhost:9090/-/reload`，不必重启。

### 步骤三：告警规则

```yaml
# /opt/prometheus/rules/node.yml
groups:
- name: node
  rules:
  - alert: HostDown
    expr: up{job="node"} == 0
    for: 2m
    labels: { severity: page }
    annotations:
      summary: "主机 {{ $labels.instance }} 失联"

  - alert: DiskWillFull
    expr: |
      (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} 
       / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"}) < 0.15
    for: 10m
    labels: { severity: warning }
    annotations:
      summary: "{{ $labels.instance }} {{ $labels.mountpoint }} 剩余不足 15%"

  - alert: HighLoad
    expr: node_load5 / count by (instance) (node_cpu_seconds_total{mode="idle"}) > 1.5
    for: 10m
    labels: { severity: ticket }
```

校验：

```bash
promtool check rules /opt/prometheus/rules/node.yml
```

### 步骤四：Alertmanager

```yaml
# /etc/alertmanager/alertmanager.yml
route:
  receiver: default
  group_by: [alertname, instance]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
- name: default
  webhook_configs:
  - url: http://127.0.0.1:8060/hook
    send_resolved: true
```

实验环境用 webhook 接一个本地接收器最简单（生产换成企业微信/飞书/邮件）。

```bash
# 极简接收器，把收到的告警打进日志
python3 -m http.server 8060
```

### 步骤五：Grafana 出图

```bash
docker run -d --name grafana -p 3000:3000 \
  -e GF_SECURITY_ADMIN_PASSWORD=admin123 \
  grafana/grafana:11.3.0
```

配置：

1. 添加数据源：`http://127.0.0.1:9090`，类型 Prometheus。
2. 导入 Node Exporter Full 面板（ID `1860`）。
3. 自建一个"业务"面板，放四条查询：

```promql
sum by (path) (rate(http_requests_total[5m]))
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
sum(up{job="demo-api"}) / count(up{job="demo-api"})
```

### 验证清单

| 验证项 | 方法 | 期望 |
| --- | --- | --- |
| 抓取正常 | `curl -s localhost:9090/api/v1/targets` | 三个 target 都是 `up` |
| 指标有值 | 控制台查 `node_load1` | 有曲线，非空 |
| 规则生效 | 控制台 Alerts 页 | 规则列在 `Inactive/Pending/Firing` |
| 告警能发 | 手动停 node_exporter | 2 分钟后 Alertmanager 收到 |
| 告警能恢复 | 重新启动 | 收到 resolved |

```bash
systemctl stop node_exporter
sleep 130
curl -s localhost:9093/api/v2/alerts | jq '.[].labels.alertname'
```

### 常见故障

**target 显示 DOWN**：

- 端口不通 → `nc -vz 192.168.1.31 9100`
- 路径不对 → `curl 192.168.1.31:9100/metrics` 是否 200
- 时间不同步 → `timedatectl`，偏差超过 2 分钟抓取会失败

**Grafana 图是空的**：

- 数据源 URL 写成了 `localhost` 但 Grafana 在容器里 → 用宿主机 IP 或 `host.docker.internal`
- 时间范围选错了（比如选了"最近 5 分钟"，但数据是 1 小时前的）
- 时区：Grafana 默认 UTC，面板显示与本地差 8 小时

**内存持续上涨**：Prometheus 的 TSDB 内存与序列基数成正比。检查高基数指标：

```bash
curl -s localhost:9090/api/v1/status/tsdb | jq '.data.seriesCountByMetricName[0:10]'
```

超过 10 万条的指标，考虑减少 label 维度（别把 `user_id`、`request_id` 放进 label）。

**告警不触发**：`for` 设置太长、`expr` 恒为 false（用 `promtool query` 验证）、Alertmanager 路由没匹配。

```bash
promtool query instant http://localhost:9090 'up{job="node"} == 0'
```

### 实验结论

一套最小可用的监控闭环只需要四个组件，但真正决定它"有用"的是三件事：**指标选得对（能反映用户体验）、告警带 runbook（收到就知道做什么）、有恢复通知（知道结束了）**。
