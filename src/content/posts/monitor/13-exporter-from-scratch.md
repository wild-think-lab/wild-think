---
title: 从零写一个 Prometheus Exporter（Go，120 行）
description: 用 Go 写一个真正能用的 exporter：指标设计、自采集逻辑、/metrics 端点、超时与错误处理，以及怎么本地验证。
date: 2026-11-27
tags: [Go, Prometheus, 监控, Exporter]
---

### 先想清指标设计

写 exporter 最容易犯的错是"把能拿到的都暴露出去"。先问三个问题：

```
① 这个指标会有人看吗？（没人看的指标是负担）
② 它的类型对吗？（counter 还是 gauge）
③ 标签会不会导致"高基数"？（如用请求 ID 当标签）
```

**四种类型的区别**：

```
counter  只增不减（请求总数、错误总数）
gauge    可增可减（当前连接数、队列长度）
histogram 分桶统计（请求耗时）
summary  分位数（一般由 histogram 算出）
```

**高基数是 Prometheus 的头号杀手**：一个标签有 10 万个不同值，就让时间序列暴涨。别把用户 ID、URL 全路径放进标签。

### 项目结构

```
my-exporter/
├── go.mod
├── main.go
└── collector.go
```

`go.mod`：

```
module example.com/myexporter

go 1.21

require github.com/prometheus/client_golang v1.18.0
```

### 第一步：定义 collector

```go
package main

import (
	"sync"

	"github.com/prometheus/client_golang/prometheus"
)

type Collector struct {
	mu sync.Mutex

	// 你的业务客户端
	client *Client

	// 指标
	up        prometheus.Gauge
	reqTotal  prometheus.Counter
	errTotal  prometheus.Counter
	scrapeDur prometheus.Histogram
	queueLen  prometheus.Gauge
}

func NewCollector(c *Client) *Collector {
	return &Collector{
		client: c,
		up: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "myexporter_up",
			Help: "1 if the target is reachable, 0 otherwise.",
		}),
		reqTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "myexporter_requests_total",
			Help: "Total upstream requests made.",
		}),
		errTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "myexporter_errors_total",
			Help: "Total failed upstream requests.",
		}),
		scrapeDur: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "myexporter_scrape_duration_seconds",
			Help:    "Time spent collecting metrics.",
			Buckets: prometheus.DefBuckets,
		}),
		queueLen: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "myexporter_queue_length",
			Help: "Pending items in the upstream queue.",
		}),
	}
}
```

**命名规范**：

```
<exporter>_<对象>_<单位>
例：myexporter_requests_total
    myexporter_scrape_duration_seconds
```

单位写在名字末尾（`_seconds`、`_bytes`），不要放标签里。

### 第二步：Describe 与 Collect

```go
func (c *Collector) Describe(ch chan<- *prometheus.Desc) {
	c.up.Describe(ch)
	c.reqTotal.Describe(ch)
	c.errTotal.Describe(ch)
	c.scrapeDur.Describe(ch)
	c.queueLen.Describe(ch)
}

func (c *Collector) Collect(ch chan<- prometheus.Metric) {
	c.mu.Lock()
	defer c.mu.Unlock()

	timer := prometheus.NewTimer(c.scrapeDur)
	defer timer.ObserveDuration()

	stats, err := c.client.Stats()
	c.reqTotal.Inc()
	if err != nil {
		c.errTotal.Inc()
		c.up.Set(0)
		ch <- c.up
		ch <- c.reqTotal
		ch <- c.errTotal
		return
	}
	c.up.Set(1)
	c.queueLen.Set(float64(stats.QueueLength))

	ch <- c.up
	ch <- c.reqTotal
	ch <- c.errTotal
	ch <- c.queueLen
}
```

**两个关键点**：

```
1) 加锁：Prometheus 会并发抓取（多个 target 时）
2) 出错时也要返回指标（up=0），否则 Prometheus 会认为 exporter 挂了
```

`prometheus.NewTimer` 会在函数返回时自动记录耗时，很省事。

### 第三步：带上游超时

```go
func (c *Client) Stats() (*Stats, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, "GET", c.base+"/stats", nil)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var s Stats
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return nil, err
	}
	return &s, nil
}
```

**必须设超时**：否则上游卡住，Prometheus 抓取也会跟着超时（默认 10s），整个监控变慢。

**默认超时要小于 Prometheus 的 scrape_timeout**（通常 10s），建议 3–5s。

### 第四步：main.go

```go
package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	addr := flag.String("listen", ":9101", "listen address")
	target := flag.String("target", "http://127.0.0.1:8080", "upstream base url")
	flag.Parse()

	client := NewClient(*target, &http.Client{Timeout: 5 * time.Second})
	col := NewCollector(client)

	reg := prometheus.NewRegistry()
	reg.MustRegister(col)
	// 可选：加上 Go 运行时指标
	// reg.MustRegister(collectors.NewGoCollector())

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{
		Timeout: 8 * time.Second,
	}))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	log.Printf("listening on %s, target %s", *addr, *target)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
```

**用 `NewRegistry` 而不是默认 registry**：避免把 Go 进程的默认指标混进来（可控性更好）。

**`/healthz`** 是给容器探针用的，和 `/metrics` 分开。

### 第五步：本地验证

```bash
go build -o myexporter .
./myexporter --target http://127.0.0.1:8080

# 另一个终端
curl -s localhost:9101/metrics | grep myexporter
```

期望看到：

```
# HELP myexporter_up 1 if the target is reachable...
# TYPE myexporter_up gauge
myexporter_up 1
# HELP myexporter_requests_total ...
# TYPE myexporter_requests_total counter
myexporter_requests_total 3
```

**用 `promtool check metrics` 校验格式**：

```bash
curl -s localhost:9101/metrics | promtool check metrics
```

它会检查命名规范与单位问题（如"用了 `_total` 但不是 counter"）。

### 第六步：接进 Prometheus

```yaml
scrape_configs:
- job_name: my-exporter
  scrape_interval: 15s
  scrape_timeout: 10s
  static_configs:
  - targets: ['10.0.0.5:9101']
```

验证：

```
Prometheus 界面 → Status → Targets → 看 my-exporter 是否 UP
Graph 页 → 查 myexporter_up
```

### 常见错误

```
❌ 在 Collect 里做重活（下游查询 10 秒）→ 抓取超时
   → 改用"后台定时采集 + Collect 只读内存值"

❌ 用请求路径当标签 → 高基数
   → 用"分组名"（如 /api/v1/users 归为 users）

❌ 出错时 panic → exporter 崩 → 所有指标消失
   → 出错时设置 up=0 并正常返回

❌ 指标名带大写/连字符
   → 必须小写 + 下划线

❌ counter 用 "requests" 而不是 "requests_total"
   → 加 _total 后缀
```

### 后台采集模式（推荐给慢速数据源）

```go
func (c *Collector) startBackground(ctx context.Context) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if stats, err := c.client.Stats(); err == nil {
				c.mu.Lock()
				c.queueLen.Set(float64(stats.QueueLength))
				c.mu.Unlock()
			}
		}
	}
}
```

`Collect` 只读内存里的值，**抓取永远在毫秒级**。这是生产 exporter 的标准做法。

### 检查清单

```
□ 指标名小写 + 下划线 + 单位后缀
□ counter 用 _total
□ 不用高基数标签（无 ID/路径/时间戳）
□ Collect 里没有重活（慢数据源用后台采集）
□ 上游请求有超时（< scrape_timeout）
□ 上游失败时返回 up=0 而不是报错退出
□ 有 /healthz 给探针用
□ promtool check metrics 通过
□ 本地 curl 验证过指标输出
```
