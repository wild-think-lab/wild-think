---
title: 实验报告：用 Prometheus + Grafana 搭一套"能从 0 看懂"的监控
description: 从零部署、抓取配置、告警规则、Grafana 面板，到一个"故意打挂服务"的验证实验。
date: 2024-02-17
tags: [实验, Prometheus, Grafana, 监控]
---

### 一、实验目的

1. 部署 Prometheus + Grafana + Alertmanager。
2. 抓取 node_exporter 与一个应用的自定义指标。
3. 配一条"能真的响"的告警。
4. 故意制造故障，验证告警链路。

### 二、环境

| 角色 | 规格 | 组件 |
| --- | --- | --- |
| monitor | 2C 4G | Prometheus / Grafana / Alertmanager |
| app | 1C 2G | node_exporter + 示例应用 |

### 三、部署（docker compose）

```yaml
version: "3.8"
services:
  prometheus:
    image: prom/prometheus:v2.53.0
    volumes:
    - ./prometheus.yml:/etc/prometheus/prometheus.yml
    - ./rules:/etc/prometheus/rules
    - prom-data:/prometheus
    command:
    - --config.file=/etc/prometheus/prometheus.yml
    - --storage.tsdb.retention.time=15d
    ports: ["9090:9090"]

  alertmanager:
    image: prom/alertmanager:v0.27.0
    volumes: ["./alertmanager.yml:/etc/alertmanager/alertmanager.yml"]
    ports: ["9093:9093"]

  grafana:
    image: grafana/grafana:11.0.0
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes: ["grafana-data:/var/lib/grafana"]
    ports: ["3000:3000"]

  node:
    image: prom/node-exporter:v1.8.0
    pid: host
    volumes: ["/:/host:ro,rslave"]
    command: ["--path.rootfs=/host"]
    ports: ["9100:9100"]

volumes:
  prom-data:
  grafana-data:
```

**为什么 `pid: host` + 挂载 `/`**：

```
node_exporter 要读宿主的 /proc 与文件系统
不挂就只能看到容器自己
```

### 四、抓取配置

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
  - static_configs:
    - targets: ['alertmanager:9093']

rule_files:
- /etc/prometheus/rules/*.yml

scrape_configs:
- job_name: node
  static_configs:
  - targets: ['node:9100']
- job_name: prometheus
  static_configs:
  - targets: ['localhost:9090']
```

**验证抓取成功**：

```
访问 http://localhost:9090/targets → 全部 UP
访问 http://localhost:9090/graph → 查询 up
```

### 五、一个应用的自定义指标

**用 Go 写一个最小的**：

```go
package main

import (
	"net/http"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var reqTotal = prometheus.NewCounterVec(
	prometheus.CounterOpts{Name: "app_requests_total", Help: "total requests"},
	[]string{"path", "code"},
)

var reqDur = prometheus.NewHistogramVec(
	prometheus.HistogramOpts{
		Name:    "app_request_duration_seconds",
		Buckets: prometheus.DefBuckets,
	},
	[]string{"path"},
)

func main() {
	prometheus.MustRegister(reqTotal, reqDur)
	http.Handle("/metrics", promhttp.Handler())
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		reqTotal.WithLabelValues("/", "200").Inc()
		reqDur.WithLabelValues("/").Observe(0.01)
		w.Write([]byte("ok"))
	})
	http.ListenAndServe(":8080", nil)
}
```

**指标命名的规范**：

```
① 用 _total 结尾表示 counter
② 用 _seconds 表示时间（base unit）
③ 用 _bytes 表示字节
④ 标签用 snake_case，不要高基数（不要 user_id）
```

**"指标名不带单位"是常见的坏习惯**（`req_time` vs `req_duration_seconds`）。

### 六、告警规则

```yaml
# rules/app.yml
groups:
- name: app
  rules:
  - alert: AppDown
    expr: up{job="app"} == 0
    for: 1m
    labels: { severity: critical }
    annotations:
      summary: "{{ $labels.instance }} 不可达"
      description: "已持续 1 分钟无法抓取"

  - alert: HighErrorRate
    expr: |
      sum(rate(app_requests_total{code=~"5.."}[5m]))
      / sum(rate(app_requests_total[5m])) > 0.05
    for: 5m
    labels: { severity: warning }
    annotations:
      summary: "5xx 比例 > 5%"

  - alert: HighLatency
    expr: |
      histogram_quantile(0.99,
        sum(rate(app_request_duration_seconds_bucket[5m])) by (le)
      ) > 0.5
    for: 5m
    labels: { severity: warning }
```

**`for: 1m` 的意义**：

```
持续 1 分钟才告警 → 过滤瞬时抖动
（没有 for 的告警会非常吵）
```

### 七、Alertmanager 配置

```yaml
route:
  receiver: default
  group_by: ['alertname']
  group_wait: 10s
  group_interval: 5m
  repeat_interval: 4h

receivers:
- name: default
  webhook_configs:
  - url: 'http://localhost:8081/alert'
```

**实验里用 webhook 最简单**（不用配邮件）。

### 八、验证实验

**① 打挂应用，看 AppDown 是否触发**

```bash
docker stop app-container
# 等 1 分钟 → Prometheus 的 /alerts 页面应显示 firing
# → Alertmanager 的 /alerts 应收到
```

**② 制造 5xx**

```bash
# 改应用让它返回 500，或用一个脚本压
for i in $(seq 1 200); do curl -s -o /dev/null http://app:8080/fail; done
```

**③ 看曲线**

Grafana 里查：

```
rate(app_requests_total[5m])
histogram_quantile(0.99, rate(app_request_duration_seconds_bucket[5m]))
```

### 九、Grafana 面板（三个必备图）

```
① 可用性：up{job=~"..."}
② 流量：sum(rate(app_requests_total[1m])) by (code)
③ 延迟：P50/P90/P99
```

**"可用性 + 流量 + 延迟"三张图** 是小团队最实用的起点。

### 十、踩坑记录

**① 抓不到目标**

```
原因：容器里 localhost 指向自己 → 应该用 service 名（node:9100）
```

**② 时间不对**

```
原因：宿主机时间漂移 → 装 chrony
```

**③ 告警不响**

```
原因：for 太长 / expr 写错 / rule_files 路径不对
排查：Prometheus UI 的 /rules 页面直接显示"是否触发"
```

**④ 面板全空**

```
原因：查询的时间范围与数据保留期不匹配（查 30 天但只留 15 天）
```

**⑤ 内存暴涨**

```
原因：高基数标签（如 url 含 id）+ 长保留期
排查：/api/v1/status/tsdb 看 series 数
```

### 十一、实验结论

```
① 监控的最小闭环 = 抓取 + 存储 + 查询 + 告警
② 指标命名与标签设计决定"可用性"（不是采集数量）
③ 告警必须有 for + 明确判据，否则就是噪音
④ 一定要"故意打挂"验证一次（否则不知道告警是否真的通）
```

**"没演练过的告警 = 没有告警"**。

### 附录：目录结构

```
monitor-lab/
├── docker-compose.yml
├── prometheus.yml
├── alertmanager.yml
├── rules/
│   └── app.yml
└── app/
    ├── main.go
    └── Dockerfile
```
