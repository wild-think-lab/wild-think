---
title: 部署监控与日志平台（自建）
module: 进阶篇
summary: Prometheus + Grafana 的最小部署、Loki 收日志、告警接入，以及容量与保留期的估算。
minutes: 50
---

### 最小监控栈

```
node_exporter（每台）→ Prometheus（拉取+存储）→ Grafana（展示）
                                      └→ Alertmanager（告警）
```

**"先上云监控"** 也合理；自建的价值是可控与成本。

### node_exporter

```bash
useradd -rs /bin/false node_exporter
tar -xzf node_exporter-*.tar.gz -C /opt
cp /opt/node_exporter-*/node_exporter /usr/local/bin/
```

```ini
# /etc/systemd/system/node_exporter.service
[Service]
User=node_exporter
ExecStart=/usr/local/bin/node_exporter --collector.systemd
Restart=on-failure
```

```bash
systemctl enable --now node_exporter
curl -s localhost:9100/metrics | head
```

### Prometheus

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/rules/*.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['127.0.0.1:9093']

scrape_configs:
  - job_name: 'node'
    static_configs:
      - targets: ['10.0.0.11:9100', '10.0.0.12:9100']
```

```bash
promtool check config /etc/prometheus/prometheus.yml
systemctl enable --now prometheus
```

**要点**：

```
① 抓取间隔 15s（更短成本翻倍）
② 保留期用 --storage.tsdb.retention.time=15d
③ 规则文件要 promtool 检查
```

### 容量估算（别事后才发现盘满）

```
每样本约 1-2 字节（压缩后）
样本数 = 序列数 × (86400/15) × 天数
例：1000 序列 × 5760 × 15 天 ≈ 8600 万样本 ≈ 100-170GB
```

**判据**：盘不够 → 缩短保留期或降抓取频率。

### Loki 收日志（省空间）

```yaml
# promtail 片段
clients:
  - url: http://10.0.0.10:3100/loki/api/v1/push
scrape_configs:
  - job_name: app
    static_configs:
      - targets: ['localhost']
        labels:
          job: app
          __path__: /var/log/app/*.log
```

**Loki 存的是索引 + 压缩块**，比全文索引省很多。

### Grafana

```bash
dnf install -y grafana
systemctl enable --now grafana-server
# 默认 3000 端口，改默认密码
```

**面板最小集**：

```
① 节点资源（CPU/内存/磁盘/网络）
② 服务存活（up 指标）
③ 错误率与 P99
④ 磁盘趋势（预测写满时间）
```

### 告警接入

```yaml
# rules/node.yml
groups:
  - name: node
    rules:
      - alert: DiskWillFill
        expr: predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs"} [6h], 24*3600) < 0
        for: 1h
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.instance }} 磁盘预计 24 小时内写满"
```

**`predict_linear`** 比"阈值 80%"更早、更有用。

### 五个"自建监控翻车"

**① 监控和被监控同机**

```
机器挂了，监控也没了
```

**② 抓取太频繁**

```
15s 变 5s → 存储 3 倍
```

**③ 高基数标签**

```
把 user_id/url 当标签 → 序列爆炸
```

**④ 告警规则没测**

```
表达式写错，永远不触发
```

**⑤ 没监控监控自己**

```
Prometheus 自己挂了没人知道
```

### 检查清单

```
□ exporter 每台都装（systemd 托管）
□ 抓取间隔与保留期匹配磁盘
□ 有容量估算
□ 规则文件 promtool 检查
□ 告警分级与抑制
□ 有 predict_linear 趋势告警
□ 监控与被监控分离
□ 标签基数受控（不放大维度）
□ 有"监控自身存活"检查
□ 有 Grafana 备份（面板/用户）
```
