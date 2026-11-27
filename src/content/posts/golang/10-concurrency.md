---
title: Go 并发：六个模式与四个必踩的坑
description: worker pool、fan-out/fan-in、errgroup、限流、超时控制、优雅退出，以及 data race 与 goroutine 泄漏。
date: 2026-11-27
tags: [Go, 并发, 编程]
---

### 把基础说清

```
goroutine：轻量线程（初始 2KB 栈，可增长）
channel  ：通信（CSP 模型，"不要通过共享内存通信"）
context  ：传递取消与超时
sync     ：Mutex / WaitGroup / Once / Pool
```

**Go 的并发哲学**：用 channel 传递数据，而不是用锁保护共享数据。**但锁在简单场景更高效**。

### 模式一：Worker Pool（最常用）

```go
func workerPool(jobs <-chan Job, results chan<- Result, workers int) {
    var wg sync.WaitGroup
    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for job := range jobs {
                results <- process(job)
            }
        }()
    }
    wg.Wait()
    close(results)
}
```

**要点**：

```
① 消费者数量固定（防打爆下游）
② 由"发送方"关闭 jobs channel（不要由接收方关）
③ wg.Wait 之后才能 close(results)
```

**关闭 channel 的规则**：

```
谁发送，谁关闭
永远不要关闭一个"可能还会有人发送"的 channel
永远不要在接收方关闭 channel
```

### 模式二：Fan-out / Fan-in

```go
func fanIn(ctx context.Context, chs ...<-chan int) <-chan int {
    out := make(chan int)
    var wg sync.WaitGroup
    for _, c := range chs {
        wg.Add(1)
        go func(c <-chan int) {
            defer wg.Done()
            for v := range c {
                select {
                case out <- v:
                case <-ctx.Done():
                    return
                }
            }
        }(c)
    }
    go func() { wg.Wait(); close(out) }()
    return out
}
```

**注意 `select` 里的 `ctx.Done()`**：没有它，下游不消费时 goroutine 永久阻塞。

### 模式三：errgroup（带错误传播）

```go
import "golang.org/x/sync/errgroup"

g, ctx := errgroup.WithContext(context.Background())
g.SetLimit(10)                       // 并发上限

for _, url := range urls {
    url := url
    g.Go(func() error {
        return fetch(ctx, url)       // 任一出错 → ctx 取消 → 其他也退出
    })
}
if err := g.Wait(); err != nil {
    log.Fatal(err)
}
```

**这是"并发调用多个下游"的最佳实践**：

```
① 有错误传播
② 有取消传播
③ 有限并发（SetLimit）
```

### 模式四：限流（rate.Limiter）

```go
import "golang.org/x/time/rate"

limiter := rate.NewLimiter(100, 10)   // 每秒 100，突发 10

for _, req := range reqs {
    if err := limiter.Wait(ctx); err != nil {
        return err
    }
    do(req)
}
```

**`Wait` vs `Allow`**：

```
Wait(ctx)  ：阻塞直到可以（尊重 ctx 取消）
Allow()    ：立即判断（不阻塞，适合"超了就丢弃"）
```

### 模式五：超时控制

```go
ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
defer cancel()

select {
case result := <-ch:
    return result
case <-ctx.Done():
    return nil, ctx.Err()
}
```

**必须 `defer cancel()`**，否则会泄漏（ctx 的定时器不释放）。

**HTTP 客户端的超时**（三层）：

```go
client := &http.Client{
    Timeout: 30 * time.Second,          // 整体
    Transport: &http.Transport{
        DialContext: (&net.Dialer{
            Timeout:   3 * time.Second,  // 连接
            KeepAlive: 30 * time.Second,
        }).DialContext,
        ResponseHeaderTimeout: 10 * time.Second,  // 首字节
        IdleConnTimeout:       90 * time.Second,
        MaxIdleConnsPerHost:   20,
    },
}
```

**只设 `client.Timeout` 是不够的**：它不控制"首字节等待"，慢接口会拖很久。

### 模式六：优雅退出

```go
srv := &http.Server{Addr: ":8080", Handler: mux}

go func() { srv.ListenAndServe() }()

quit := make(chan os.Signal, 1)
signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
<-quit

ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()
if err := srv.Shutdown(ctx); err != nil {
    log.Fatal("forced shutdown:", err)
}
```

**`Shutdown` 做的事**：

```
① 停止接受新连接
② 等待已有请求完成（直到 ctx 超时）
```

**没有它，滚动发布时会有 5xx**。

### 坑一：data race（必用 `-race`）

```bash
go test -race ./...
go run -race main.go
```

**最常见的 race**：

```go
// 错：闭包捕获循环变量（Go 1.22 前）
for _, v := range items {
    go func() { fmt.Println(v) }()   // 全是最后一个值
}

// 对（Go 1.22+ 已修复，但显式更安全）
for _, v := range items {
    v := v
    go func() { fmt.Println(v) }()
}
```

**`go test -race` 应该进 CI**，不带它等于闭眼开车。

### 坑二：goroutine 泄漏

**三种泄漏模式**：

```go
// ① 发送方永久阻塞（没人接收）
ch := make(chan int)
go func() { ch <- 1 }()      // 泄漏

// ② 接收方永久阻塞（没人发送也没关闭）
go func() { <-ch }()         // 泄漏

// ③ 忘记 cancel
ctx, _ := context.WithTimeout(...)   // 定时器不释放
```

**检测**：

```go
import "runtime/pprof"

// 定期打印
pprof.Lookup("goroutine").WriteTo(os.Stdout, 1)
```

**或**：

```go
import "github.com/uber-go/goleak"

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}
```

**`goleak` 是测试层的自动检测**，非常推荐。

### 坑三：channel 缓冲大小

```
无缓冲：发送方阻塞到接收方就绪（同步）
有缓冲：缓冲满了才阻塞
```

**结论**：

```
① 无缓冲 channel 会强制"配对"，容易造成卡顿
② 缓冲不是越大越好（掩盖背压问题）
③ "结果 channel"建议带缓冲 = goroutine 数（防泄漏）
```

```go
results := make(chan Result, len(jobs))   // 防"无人接收时发送方卡住"
```

### 坑四：`sync.Pool` 的误用

```go
var bufPool = sync.Pool{
    New: func() any { return new(bytes.Buffer) },
}

buf := bufPool.Get().(*bytes.Buffer)
buf.Reset()                    // 必须清空！
defer bufPool.Put(buf)
```

**误用**：

```
① 放进去前没 Reset（下次拿到脏数据）
② 放进去的对象被外部还持有（race）
③ 期望 Pool 一定复用（GC 会清空 Pool）
```

**`sync.Pool` 适合"临时缓冲区"**，不适合当缓存。

### 一个"并发抓取 URL"的完整例子

```go
func fetchAll(ctx context.Context, urls []string, limit int) ([]string, error) {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(limit)
    results := make([]string, len(urls))

    for i, u := range urls {
        i, u := i, u
        g.Go(func() error {
            body, err := fetch(ctx, u)
            if err != nil { return err }
            results[i] = body       // 各写各的索引 → 无 race
            return nil
        })
    }
    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}
```

**注意"各写各的索引"**：这是避免锁的常用技巧。

### 检查清单

```
□ CI 跑 go test -race
□ 用 errgroup 管理并发（含 SetLimit）
□ 所有 ctx 有 defer cancel
□ channel 由发送方关闭
□ 结果 channel 带缓冲（防阻塞）
□ 有超时的三层配置（客户端/连接/首字节）
□ 有优雅退出（Shutdown + 信号）
□ 用 goleak 检测 goroutine 泄漏
□ sync.Pool 用前 Reset
□ 循环变量显式复制（或 Go 1.22+）
□ 限流用 rate.Limiter
```
