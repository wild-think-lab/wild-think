---
title: Go 的性能分析：pprof 三件套与 benchmark 怎么跑
description: CPU/内存/阻塞三种 profile 分别看什么、benchmark 的正确写法与常见误用、pprof 火焰图怎么读、以及线上服务怎么安全地开 profile。
date: 2026-11-27
tags: [Go, pprof, 性能, benchmark]
---

### 三种 profile，各看各的

| 类型 | 回答的问题 | 典型症状 |
| --- | --- | --- |
| CPU（`profile`） | 时间花在哪 | CPU 高、吞吐上不去 |
| 内存（`heap`） | 内存被谁占了 | RSS 上涨、GC 频繁 |
| 阻塞（`block`/`mutex`） | 谁在等谁 | 延迟高但 CPU 不高 |

**CPU 高先看 CPU，延迟高先看 block/mutex，内存涨看 heap。** 抓错类型等于白忙。

### 在代码里加 HTTP 端点（最简单）

```go
import (
	"net/http"
	_ "net/http/pprof"
)

func main() {
	// 只监听本机，别暴露到公网
	go func() {
		_ = http.ListenAndServe("127.0.0.1:6060", nil)
	}()
	// 业务服务
}
```

采集：

```bash
go tool pprof -http=:8080 http://127.0.0.1:6060/debug/pprof/profile?seconds=30   # CPU 30 秒
go tool pprof -http=:8080 http://127.0.0.1:6060/debug/pprof/heap                 # 内存快照
go tool pprof -http=:8080 http://127.0.0.1:6060/debug/pprof/block                # 阻塞
curl http://127.0.0.1:6060/debug/pprof/goroutine?debug=1                          # goroutine 栈
```

`-http` 会启动一个本地网页，直接看火焰图、调用图、源码热区。比命令行 `top`/`list` 直观得多。

### 关键命令

```bash
go tool pprof -top -cum profile.pb.gz        # 按累积耗时排序
go tool pprof -list 'handlerFunc' profile.pb.gz   # 具体函数逐行耗时
go tool pprof -peek 'json.Marshal' profile.pb.gz   # 谁调用了它
```

`-cum` 很重要：默认按自身耗时排序，而瓶颈往往在"自己没花时间但调用了很慢的东西"的函数上。

### 火焰图怎么读

- **横轴是调用栈宽度**（占采样比例），越宽越耗时。
- **纵轴是调用栈深度**，下层是上层调用的。
- 找"又宽又深"的块：宽代表占比大，深代表调用链长。
- 常见的坏形状：一整条平坦的宽块（说明某一步占了 80% 时间）；大量细碎的小块（说明频繁的小调用、GC 压力）。

### benchmark 的正确写法

```go
func BenchmarkParseOrder(b *testing.B) {
	data := loadFixture()          // 准备数据放循环外
	b.ResetTimer()                 // 重置计时，别把准备时间算进去
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_, _ = ParseOrder(data)
		}
	})
}
```

```bash
go test -bench=. -benchmem -count=5 ./...
```

`-benchmem` 给出每次操作的分配次数与字节数，比单纯 ns/op 更能指向问题：`8 allocs/op` 通常意味着可以复用对象或改值类型。

三次以上重复（`-count=5`）才能区分噪声与真实差异，用 `benchstat` 比对：

```bash
go test -bench=. -count=5 ./... > old.txt
# 改代码
go test -bench=. -count=5 ./... > new.txt
benchstat old.txt new.txt
```

### benchmark 的五个误用

1. **在循环里做 IO**：benchmark 测的是 CPU 逻辑，带网络会把噪声放大一百倍。
2. **没有 `b.ResetTimer()`**：准备数据的耗时被算进结果。
3. **编译器把结果优化掉了**：把结果赋给包级变量或用 `b.ReportAllocs()` 配合 `sink` 变量。
4. **只跑一次**：`-count=1` 的数字容易被 CPU 频率与 GC 时机影响。
5. **用 `time.Since` 手写计时**：拿不到分配统计，还容易漏掉预热。

### 编译期与运行期的手段

```go
// 逃逸分析：看变量是否被分配到堆
go build -gcflags='-m' ./...

// 内联决策
go build -gcflags='-m -m' ./... | grep 'inlining'

// 逃逸到堆的对象越多，GC 压力越大
GOGC=50 ./app          # 更激进地回收（CPU 换内存）
GOMEMLIMIT=1GiB ./app  # 软上限，容器里很有用
```

`GOMEMLIMIT`（Go 1.19+）是容器环境的关键：让 GC 知道"内存上限是多少"，避免 RSS 一路涨到被 cgroup 杀掉。

### 线上安全地开 profile

三条纪律：

1. **只监听 127.0.0.1 或内网**，绝不暴露公网（profile 端点会泄露调用栈与内存内容）。
2. **采样有成本**：CPU profile 默认 100Hz，能接受；`heap` 会触发 STW 一小段，别在高峰频繁抓。
3. **抓完就关**：用环境变量控制开关，默认关闭。

```go
if os.Getenv("ENABLE_PPROF") == "1" {
	go func() { _ = http.ListenAndServe("127.0.0.1:6060", nil) }()
}
```

### 一张排查顺序表

| 症状 | 先看 | 常见结论 |
| --- | --- | --- |
| CPU 100% | CPU profile | 序列化/正则/加密占大头 |
| 内存缓慢上涨 | heap（inuse_space） | 缓存无上限、goroutine 泄漏 |
| GC 占比高 | `GODEBUG=gctrace=1` | 分配太频繁或 GOGC 太激进 |
| 延迟高、CPU 不高 | block/mutex | 锁竞争、channel 阻塞、DB 等待 |
| goroutine 数暴涨 | goroutine 栈 | 每请求起 goroutine 未退出 |

### 一句话总结

pprof 的价值不在"能出图"，而在**用数据替换猜测**：先确定是哪一类问题，再抓对应 profile，最后 `-cum` + `-list` 定位到具体行。
