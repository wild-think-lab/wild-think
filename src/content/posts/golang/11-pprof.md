---
title: Go 性能剖析：pprof 三种 profile 怎么用
description: CPU/内存/阻塞三种 profile 的采集方式、火焰图怎么看，以及五个"profile 看不出来"的原因。
date: 2024-04-30
tags: [Go, 性能, pprof]
---

### 三种 profile

```
① CPU profile      ：谁在消耗 CPU（采样式）
② Heap profile     ：谁在分配内存（采样式）
③ Block/Mutex      ：谁在等锁/等 IO
```

**"CPU 高"用 CPU profile；"内存涨"用 heap；"CPU 不高但慢"用 block**。

### 最快的接入方式

```go
import _ "net/http/pprof"

func main() {
    go func() {
        http.ListenAndServe("127.0.0.1:6060", nil)  // 只监听本地！
    }()
    // ...
}
```

```bash
go tool pprof http://127.0.0.1:6060/debug/pprof/profile?seconds=30
go tool pprof http://127.0.0.1:6060/debug/pprof/heap
go tool pprof http://127.0.0.1:6060/debug/pprof/block
```

**`127.0.0.1` 而不是 `:6060`** —— 暴露到公网等于开了个免费的诊断后门。

### 火焰图

```bash
go tool pprof -http=:8081 profile.pb.gz
```

**或**：

```bash
go tool pprof -http=:8081 http://127.0.0.1:6060/debug/pprof/profile?seconds=30
```

**看火焰图的顺序**：

```
① 先看"最宽的块"（占比最大）
② 再看"最深的链"（调用路径长）
③ 找"自己代码的函数"（不要盯着 runtime 底层）
```

**"宽的 runtime 函数"往往是你调用的结果**（如 `runtime.mallocgc` 宽 → 分配多）。

### CPU profile 的关键字段

```
flat  ：该函数自身消耗（不含子调用）
cum   ：该函数及其子调用总消耗
```

```bash
go tool pprof -top -cum profile.pb.gz | head -30
go tool pprof -top profile.pb.gz | head -30
```

**`-top -cum` 找"入口函数"，`-top` 找"热点函数"**。

### 内存剖析

```bash
go tool pprof -alloc_space profile.pb.gz     # 累计分配（含已释放）
go tool pprof -inuse_space profile.pb.gz     # 当前占用
```

**区别很重要**：

```
alloc_space 高但 inuse 低 → 分配频繁但很快释放（GC 压力）
inuse 高 → 真的泄漏/缓存过多
```

**"GC CPU 占比高"通常来自 alloc_space 过高**。

### 一个典型的判断流程

```
现象：P99 400ms，CPU 60%
1) CPU profile → 没有明显热点（CPU 不是瓶颈）
2) block profile → 大量 goroutine 卡在 sync.Mutex / chan
3) 定位到某个"全局锁保护的 map"
4) 结论：锁竞争
```

**"CPU 不高但慢" 一定要看 block profile**。

### 五个"profile 看不出来"的原因

**① 采样率太低/时间太短**

```
默认 100Hz，10 秒 → 1000 个样本
冷路径（每秒几次）根本采不到
→ 延长时间或针对"低频高耗时"用 trace
```

**② 内联导致函数名丢失**

```
编译器内联后，热点显示在调用者身上
→ 用 `-gcflags=-l` 关闭内联复测（仅诊断用）
```

**③ 只看了 flat 没看 cum**

```
热点在底层 runtime，真正的问题在调用它的业务代码
```

**④ 是"等待"不是"计算"**

```
等 IO/等锁 → CPU profile 全是空白
→ 用 block profile 或 trace
```

**⑤ 问题在"上游/下游"**

```
本服务很快，慢在数据库或下游服务
→ profile 当然看不出
```

### trace（补充手段）

```go
import "runtime/trace"

f, _ := os.Create("trace.out")
trace.Start(f)
defer trace.Stop()
```

```bash
go tool trace trace.out
```

**"为什么这次请求花了 500ms"** → trace 能看到 goroutine 的完整时间线（含阻塞/调度）。

### 生产注意

```
① pprof 端点只监听本地/内网
② 加鉴权或临时开启
③ 采样时长可控（30 秒足够）
④ 采集期间观察 CPU 与内存（采样本身有开销）
```

### 检查清单

```
□ 有 pprof 端点（仅内网）
□ 会看 flat 与 cum
□ 会区分 alloc_space 与 inuse_space
□ CPU 不高时用 block profile
□ 会生成火焰图
□ 必要时用 trace 看单请求时间线
□ 采集时长与采样率合理
□ 内联/内联关闭的差异知道
□ 生产端点有保护
```
