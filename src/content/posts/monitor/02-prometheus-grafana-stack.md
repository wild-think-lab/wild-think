---
title: Prometheus + Grafana 最小可用栈（含抓取与告警配置）
description: 从零搭一套能用的监控：node_exporter 采集、PromQL 查询、Grafana 面板、Alertmanager 发通知。
date: 2026-11-23
tags: [监控, Prometheus, Grafana, PromQL, 实验]
---

### 四件套各干什么

```text
node_exporter（被监控机上采数据） → Prometheus（拉取 + 存储 + 查询）
                                   → Grafana（画图）
                                   → Alertmanager（分组 + 去重 + 发通知）
```

关键认知：**Prometheus 是拉模型（pull）**，服务端主动去目标抓，不是目标推。

### 1. 启动 node_exporter

```bash
wget https://github.com/prometheus/node_exporter/releases/download/v1.8.2/node_exporter-1.8.2.linux-amd64.tar.gz
tar -xf node_exporter-1.8.2.linux-amd64.tar.gz
sudo mv node_exporter-1.8.2.linux-amd64/node_exporter /usr/local/bin/
sudo useradd -rs /bin/false nodeusr

sudo tee /etc/systemd/system/node_exporter.service <<'EOF'
[Unit]
Description=Node Exporter
After=network.target

[Service]
User=nodeusr
ExecStart=/usr/local/bin/node_exporter
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload && sudo systemctl enable --now node_exporter
curl -s localhost:9100/metrics | head
```

看到 `node_cpu_seconds_total` 之类就说明采集正常。

### 2. 配置 Prometheus 抓取

`/etc/prometheus/prometheus.yml`：

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - "/etc/prometheus/rules/*.yml"

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["localhost:9093"]

scrape_configs:
  - job_name: "node"
    static_configs:
      - targets: ["localhost:9100", "10.0.0.5:9100"]
```

```bash
promtool check config /etc/prometheus/prometheus.yml   # 改完先校验
systemctl restart prometheus
```

`promtool check` 这一步能省掉大量"改完起不来"的时间。

### 3. 三条必会的 PromQL

```promql
# CPU 使用率（按实例）
100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# 内存使用率
100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

# 磁盘剩余（按挂载点）
node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / 1024^3
```

三条规律：

- 计数器（`_total`）用 `rate()` 求每秒增量。
- 瞬时值（`_bytes`）直接算比例。
- `by(instance)` 让结果按机器分组，方便一台一台看。

### 4. 告警规则

`/etc/prometheus/rules/node.yml`：

```yaml
groups:
  - name: node-basic
    rules:
      - alert: DiskWillFillIn4Hours
        expr: predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[1h], 4*3600) < 0
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.instance }} 磁盘将在 4 小时内写满"

      - alert: InstanceDown
        expr: up == 0
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "{{ $labels.instance }} 抓取失败"
```

`predict_linear` 是 Prometheus 最有用的函数之一：**按当前增长速度预测多久后归零**，比"磁盘 >85%"提前得多。

`for` 用来抑制抖动：持续 10 分钟才报。

### 5. Grafana 面板

导入 Node Exporter Full（ID `1860`）能立刻得到一套完整面板；但建议自己搭一版只含六个格子的：

```text
CPU 使用率 | 内存使用率 | 磁盘剩余
网络出入 | 负载 1/5/15 | 抓取状态
```

自己搭的好处是知道每个查询在算什么，出问题能改。

### 6. Alertmanager 去重与分组

```yaml
route:
  group_by: ["alertname", "instance"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: "webhook"
```

含义：同类告警合并成一条、等 30 秒攒一攒、5 分钟更新、4 小时才重复提醒。没有这套，一次网络抖动就能刷出 200 条通知。

### 本章要点

- Prometheus 是 pull 模型，node_exporter 负责暴露指标。
- 计数器用 `rate()`，瞬时值直接算，`by(instance)` 分组。
- `predict_linear` 预测磁盘写满，比阈值告警更早。
- Alertmanager 的 group/repeat 是防告警风暴的关键。
