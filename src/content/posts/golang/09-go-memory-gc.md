---
title: Go 的内存与 GC：为什么"内存一直涨"不一定是泄漏
description: GOGC 与 GOMEMLIMIT、堆与栈、逃逸分析、常见"看起来泄漏"的四种情况，以及怎么真正确认泄漏。
date: 2023-11-06
tags: [Go, GC, 内存, 性能]
---

### 先破除一个误解

```
Go 程序 RSS 一直涨，不一定是泄漏
```

**原因**：Go 的 GC 是"目标驱动"的：它不追求"内存越低越好"，而是"在目标比率下尽量少 GC"。

```
GOGC=100（默认）：堆增长到上次 GC 后的 2 倍才回收
```

**所以**：

```
活跃对象 100MB → 堆可以涨到 200MB 才 GC
再涨到 400MB？不，GC 后回收，稳定在 100–200MB 之间
```

**"稳定在一个高位"是正常的**，不是泄漏。

### 两个关键参数

```bash
# GOGC：每次 GC 后，允许堆增长到多少百分比
GOGC=100        # 默认：涨到 2 倍就 GC（更省内存，更多 GC）
GOGC=200        # 涨到 3 倍才 GC（更少 GC，更多内存）

# GOMEMLIMIT：软上限（Go 1.19+）
GOMEMLIMIT=2GiB
```

**`GOMEMLIMIT` 的价值**：

```
容器设了 2GiB limit → 程序里设 GOMEMLIMIT=1800MiB
→ GC 会更积极地在接近上限时回收，避免被 OOM kill
```

**注意**：`GOMEMLIMIT` 是"软限制"，不是硬保证（Go 会说"我尽量"）。

### 容器场景的正确配置

```yaml
resources:
  limits:
    memory: 2Gi
env:
- name: GOMEMLIMIT
  value: "1800MiB"
- name: GOGC
  value: "100"
```

**为什么要留 200MiB**：

```
Go 运行时自身、栈、cgo、以及"软限制不保证"的余量
```

**只设 GOMEMLIMIT 而不设 limit** 会让宿主内存被吃（因为 GC 觉得"上限很远"）。

### 堆与栈

```
栈：每个 goroutine 独立，默认 2KB 起，按需增长（最大 1GB）
堆：全局共享，由 GC 管理
```

**"变量在栈还是堆"由逃逸分析决定**：

```go
func f() *int {
    x := 1
    return &x      // x 逃逸到堆（因为地址被返回）
}

func g() int {
    x := 1
    return x       // x 在栈上
}
```

**查看逃逸分析**：

```bash
go build -gcflags='-m' ./...
# 输出：x escapes to heap
```

**"减少逃逸"能减少 GC 压力**，但不要为此写难懂的代码（除非实测是瓶颈）。

### 四种"看起来像泄漏"的情况

**① 大 slice 只用了少量元素**

```go
// 差：截取后仍持有底层大数组
big := make([]byte, 1<<20)
small := big[:10]
// small 仍让整个 1MB 无法回收

// 好
small := make([]byte, 10)
copy(small, big[:10])
```

**② map 删除了 key 但没缩容**

```go
// Go 的 map 删除 key 不会释放桶（底层数组不缩）
m := make(map[int][1024]byte)
for i := 0; i < 100000; i++ { m[i] = ... }
for i := 0; i < 100000; i++ { delete(m, i) }
// 内存基本没降

// 解决：定期重建 map，或用 sync.Map（也有类似问题）
```

**③ goroutine 泄漏**

```go
// 差：channel 无缓冲，没人读 → goroutine 永远阻塞
go func() { ch <- result }()

// 好：带 ctx 或缓冲
go func() {
    select {
    case ch <- result:
    case <-ctx.Done():
    }
}()
```

**判断方法**：

```go
// 暴露 goroutine 数量
http.HandleFunc("/debug/goroutines", func(w, r) {
    w.Write([]byte(strconv.Itoa(runtime.NumGoroutine())))
})
```

**持续上涨 = 泄漏**。

**④ 缓存没有上限**

```go
// 差：无上限的本地缓存
var cache = map[string][]byte{}
func get(k string) []byte {
    if v, ok := cache[k]; ok { return v }
    v := load(k)
    cache[k] = v        // 永不清理
    return v
}

// 好：用带淘汰的库（如 bigcache / ristretto / lru）
```

**"本地缓存"是最常见的真泄漏来源**。

### 怎么真正确认泄漏

**对比两个时间点的堆**：

```bash
# 1. 开 pprof
import _ "net/http/pprof"
go func() { http.ListenAndServe(":6060", nil) }()

# 2. 抓两次（间隔 10 分钟）
curl -s "http://localhost:6060/debug/pprof/heap" > h1.pb.gz
sleep 600
curl -s "http://localhost:6060/debug/pprof/heap" > h2.pb.gz

# 3. 对比（-base 参数看"增长的部分"）
go tool pprof -http=:8080 -base h1.pb.gz h2.pb.gz
```

**看 `inuse_space` 的增长**（不是 `alloc_space`）：

```
alloc_space：累计分配（含已回收的）
inuse_space：当前占用 ← 这个涨才是泄漏
```

**pprof 里最有用的一列**：

```
(pprof) top -cum
→ 按"累计"排序，能看到"是谁调用导致的"
```

### GC 压力怎么看

```bash
# GODEBUG 打印 GC 日志
GODEBUG=gctrace=1 ./app

# 输出
# gc 12 @3.5s 3%: 0.012+0.45+0.008 ms clock, ...
#    ↑第几次  ↑运行时间  ↑GC 占用 CPU 比例
```

**"3%" 表示 GC 占用了 3% 的 CPU**，超过 20% 说明分配太频繁。

**更细的指标（Prometheus）**：

```
go_gc_duration_seconds            GC 暂停时间
go_memstats_heap_inuse_bytes      堆占用
go_memstats_alloc_bytes_total     累计分配速率
go_goroutines                     goroutine 数
```

### 减少分配的三个实用手段

**① 预分配容量**

```go
// 差：反复扩容（每次翻倍 + 拷贝）
var s []int
for i := 0; i < 10000; i++ { s = append(s, i) }

// 好
s := make([]int, 0, 10000)
```

**② 用 `sync.Pool` 复用大对象**

```go
var bufPool = sync.Pool{
    New: func() any { return make([]byte, 0, 4096) },
}

buf := bufPool.Get().([]byte)
defer bufPool.Put(buf[:0])
```

**③ 避免字符串拼接**

```go
// 差
s := ""
for _, x := range items { s += x }

// 好
var b strings.Builder
for _, x := range items { b.WriteString(x) }
```

### 检查清单

```
□ 容器里设 GOMEMLIMIT（约 limit 的 90%）
□ 知道 GOGC 的含义（不是越小越好）
□ 大 slice 截取时 copy（不持有底层）
□ map 大量删除后考虑重建
□ goroutine 有 ctx 或退出路径
□ 本地缓存有上限与淘汰
□ 用 inuse_space 判断泄漏（不是 alloc_space）
□ 两次 heap 对比 + pprof -base
□ gctrace 看 GC 占比（> 20% 要优化分配）
□ 关键路径预分配容量
```
