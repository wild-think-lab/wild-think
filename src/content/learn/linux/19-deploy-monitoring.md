---
title: 部署监控与日志平台（自建）
module: 熟练篇
summary: Prometheus + Grafana 的最小部署、Loki 收日志、告警接入，以及容量与保留期的估算。
minutes: 50
---

## 一、先弄懂它是什么

**监控 = 把"系统现在过得怎么样"变成可查询的时序数据，再按规则叫醒人。**

```
被监控端（exporter） ← 拉取（scrape） ← Prometheus（存储+规则）→ 告警 → 人
                                                    ↓
                                              Grafana（展示）
```

### 为什么用"拉"而不是"推"

```
拉（pull）：服务端主动抓，目标挂了就抓不到 → 本身就是"存活检测"
推（push）：目标主动上报，适合短生命周期任务/跨网络边界
```

**判据**：批量任务、Serverless、跨公网场景用 pushgateway/remote_write；常驻服务用 pull。

### 时序数据的关键概念

| 概念 | 含义 | 影响 |
| --- | --- | --- |
| metric | 指标名 + 标签集合 + 时间戳 + 值 | 标签基数爆炸 = 存储爆炸 |
| label | 维度（instance/job/status） | 别把 user_id/url 当标签 |
| scrape_interval | 抓取间隔 | 15s 是常规；缩短成本翻倍 |
| retention | 保留期 | 与磁盘直接相关 |
| rule | 告警/记录规则 | 用 PromQL 表达 |

**"高基数"是最常见的性能杀手**：标签取值越多，序列数越多，内存与磁盘线性上涨。

### PromQL 的三个常用形态

```promql
rate(http_requests_total[5m])                      # 速率
histogram_quantile(0.99, rate(latency_bucket[5m])   # P99（基于直方图）
predict_linear(node_filesystem_avail_bytes[6h], 86400) < 0   # 预测写满
```

**判据**：P99 必须用直方图算，用平均值会掩盖长尾。

### 告警的本质

```
告警 = 表达式（什么算异常）+ for（持续多久）+ 分级 + 抑制 + 接收人
```

没有 `for` 的告警 = 抖动即响；没有抑制 = 一次网络抖动响 200 条。

### 容量估算（别等磁盘满）

```
序列数 × (86400/scrape_interval) × 保留天数 × 约 1-2 字节（压缩后）
例：1000 序列，15s，15 天 ≈ 1000×5760×15 ≈ 8600 万样本 ≈ 100-170GB
```

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
