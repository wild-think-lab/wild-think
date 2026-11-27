---
title: 自己写一个 exporter：把业务指标接进 Prometheus
description: 四种指标暴露方式、Go/Python 两种实现、指标命名的规范、以及"自定义指标接不上"的排查。
date: 2024-08-15
tags: [监控, Prometheus, exporter, 指标]
---

### 四种暴露方式

| 方式 | 做法 | 适用 |
| --- | --- | --- |
| 直接暴露 `/metrics` | 应用内集成 client 库 | 自有服务（最推荐） |
| 独立 exporter | 单独进程去采集 | 第三方系统（如 MySQL/Redis） |
| Pushgateway | 短任务主动推送 | 批处理任务（不适合长驻服务） |
| 文本文件（textfile） | 写 `.prom` 文件给 node_exporter 读 | 脚本/定时任务（最轻量） |

**判断**：

```
长期运行 + 自己写的代码 → 集成 client 库
长期运行 + 别人的系统 → 独立 exporter
定时跑的脚本 → textfile 或 pushgateway
```

### 指标命名的规范

```
格式：<namespace>_<subsystem>_<name>_<unit>
例：app_http_requests_total
    app_http_request_duration_seconds
    app_queue_pending_jobs
```

四条规则：

```
① 用 base unit（秒而不是毫秒，字节而不是 KB）
② 计数器用 _total 后缀
③ 标签不要放高基数值（user_id、request_id 会炸掉 Prometheus）
④ 需要被求和的用 counter，需要被平均的用 gauge，分布用 histogram
```

**高基数标签是最常见的事故**：把 `order_id` 做标签，一天能产生几百万个时间序列。

### Go 实现（最简）

```go
package main

import (
    "net/http"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    reqTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Namespace: "app", Subsystem: "http",
            Name: "requests_total", Help: "HTTP 请求总数",
        },
        []string{"method", "status"},
    )
    reqDur = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Namespace: "app", Subsystem: "http",
            Name: "request_duration_seconds",
            Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5},
        },
        []string{"route"},
    )
)

func init() {
    prometheus.MustRegister(reqTotal, reqDur)
}

func handler(w http.ResponseWriter, r *http.Request) {
    timer := prometheus.NewTimer(reqDur.WithLabelValues("/api/orders"))
    defer timer.ObserveDuration()
    // ... 业务
    reqTotal.WithLabelValues(r.Method, "200").Inc()
}

func main() {
    http.Handle("/metrics", promhttp.Handler())
    http.HandleFunc("/api/orders", handler)
    http.ListenAndServe(":8080", nil)
}
```

**要点**：

- `CounterVec` 用 `.Inc()` / `.Add()`
- `HistogramVec` 用 `NewTimer` 或 `.Observe(seconds)`
- **不要每次请求创建新的 metric**（会内存泄漏），要在 init 时注册

### Python 实现

```python
from prometheus_client import Counter, Histogram, start_http_server
import time

REQ = Counter('app_http_requests_total', 'HTTP 请求总数', ['method', 'status', 'route'])
DUR = Histogram('app_http_request_duration_seconds', '请求耗时',
                ['route'], buckets=(.005,.01,.025,.05,.1,.25,.5,1,2.5))

def handle(method, route, status):
    start = time.time()
    try:
        pass                      # 业务
    finally:
        DUR.labels(route=route).observe(time.time() - start)
        REQ.labels(method=method, status=str(status), route=route).inc()

start_http_server(9101)           # 单独端口暴露 /metrics
```

**注意**：`start_http_server` 会再起一个线程/端口，与业务端口分开更安全（避免 `/metrics` 暴露到公网）。

### 独立 exporter（采集别人的系统）

一个最小 Python exporter：

```python
import subprocess, json
from prometheus_client import Gauge, start_http_server, REGISTRY

CONN = Gauge('mysql_threads_connected', '当前连接数')
SLOW = Gauge('mysql_slow_queries_total', '慢查询累计')

def collect():
    out = subprocess.check_output([
        'mysql', '-N', '-e',
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Slow_queries')"
    ], text=True)
    for line in out.strip().splitlines():
        name, val = line.split('\t')
        if name == 'Threads_connected': CONN.set(float(val))
        else: SLOW.set(float(val))

if __name__ == '__main__':
    start_http_server(9104)
    while True:
        try: collect()
        except Exception as e: print('collect failed:', e)
        import time; time.sleep(15)
```

### Prometheus 侧配置

```yaml
scrape_configs:
- job_name: 'app'
  static_configs:
  - targets: ['10.0.0.10:8080']
    labels:
      env: prod
      service: order-api
```

### "自定义指标接不上"的排查

| 现象 | 原因 |
| --- | --- |
| Target `down` | 端口不通 / 路径不是 `/metrics` |
| 指标不出现 | 名字与 `namespace` 拼接不符（实际是 `app_http_requests_total`） |
| 图表断断续续 | 抓取超时（`scrape_timeout` 太短，采集慢） |
| Prometheus 内存暴涨 | 高基数标签，或标签组合爆炸 |
| 数值总是 0 | Counter 没被调用，或 `Inc()` 写在了错误分支 |

```bash
# 手工验证
curl -s http://10.0.0.10:8080/metrics | grep app_http
# Prometheus 里查目标状态
# 在 Prometheus UI 的 /targets 页面看 last scrape 与 error
```

### 用 textfile 采集脚本指标（最轻量）

```bash
#!/usr/bin/env bash
# 由 cron 每分钟跑一次
OUT=/var/lib/node_exporter/textfile/backup.prom
TMP=$(mktemp)
{
  echo "backup_last_success_timestamp $(date +%s)"
  echo "backup_size_bytes $(du -sb /backup | awk '{print $1}')"
  echo "backup_duration_seconds 42"
} > "$TMP"
mv "$TMP" "$OUT"      # 原子替换（避免读到半边文件）
```

`mv` 而不是直接写：**避免 node_exporter 读到写了一半的文件**。

### 检查清单

```
□ 指标命名符合 `<ns>_<subsystem>_<name>_<unit>`
□ 用 base unit（秒/字节）
□ 标签不做高基数
□ metric 在启动时注册一次，不在请求里创建
□ `/metrics` 与业务端口分开（必要时只绑内网）
□ 采集超时与抓取间隔匹配
□ textfile 用原子替换
□ 有 exporter 自身的存活监控
```
