---
title: Go 并发：四种真正会在生产里用到的模式
description: 限并发 worker pool、context 取消传播、errgroup 与信号量、超时与背压，以及 goroutine 泄漏怎么查。
date: 2022-10-25
tags: [Go, 并发, context, 性能]
---

### 并发不是"多开 goroutine"

Go 让开 goroutine 变得太容易，于是最常见的生产事故是**无限制 fork**：

```go
for _, item := range items {   // items 有 100 万条
    go process(item)           // 瞬间创建 100 万 goroutine
}
```

后果：内存暴涨、调度开销压过实际工作、下游被打挂。

生产上真正有用的模式只有四种。

### 模式一：限并发 worker pool

```go
func Run(items []Item, workers int) error {
    jobs := make(chan Item)
    errs := make(chan error, workers)

    var wg sync.WaitGroup
    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for it := range jobs {
                if err := process(it); err != nil {
                    errs <- err
                }
            }
        }()
    }

    go func() {
        defer close(jobs)
        for _, it := range items {
            jobs <- it
        }
    }()

    wg.Wait()
    close(errs)
    for err := range errs {
        return err   // 或聚合所有错误
    }
    return nil
}
```

要点：

- `workers` 由下游容量决定（数据库连接池大小、第三方限流额度）。
- `errs` 要有缓冲，否则 worker 会阻塞在发送上。
- 任务的发送与消费必须解耦，否则发送方会堵住。

### 模式二：context 取消必须贯穿到底

```go
func handler(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
    defer cancel()

    data, err := fetch(ctx, "http://upstream/data")
    if err != nil {
        http.Error(w, err.Error(), 504)
        return
    }
    _ = data
}

func fetch(ctx context.Context, url string) ([]byte, error) {
    req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    return io.ReadAll(resp.Body)
}
```

三个必须遵守的规则：

1. **每个阻塞调用都接受 ctx**（HTTP、DB、Redis、chan 等待）。
2. **`defer cancel()`**，否则 `WithTimeout` 会泄漏 timer。
3. **不要用 `context.Background()` 替换上游 ctx**，那会让超时失效——这是最隐蔽的性能问题来源。

检查方法：

```bash
go vet ./...          # 部分 ctx 误用能被 go vet 发现
staticcheck ./...     # SA1012/SA1013 直接报
```

### 模式三：errgroup + 信号量

多个并行调用，一个失败就都取消：

```go
g, ctx := errgroup.WithContext(context.Background())
sem := make(chan struct{}, 8)   // 最多 8 个并发

for _, url := range urls {
    url := url
    g.Go(func() error {
        select {
        case sem <- struct{}{}:
            defer func() { <-sem }()
        case <-ctx.Done():
            return ctx.Err()
        }
        return fetchAndStore(ctx, url)
    })
}
if err := g.Wait(); err != nil {
    log.Printf("partial failure: %v", err)
}
```

`errgroup.WithContext` 的价值：**第一个错误触发 ctx 取消，其他 goroutine 立刻退出**，不会继续白干。

`sem` 的价值：`g.Go` 本身不限并发，没有 sem 就等于无限并发。

### 模式四：超时 + 背压

不要让调用方无限等待：

```go
select {
case result := <-ch:
    return result, nil
case <-time.After(2 * time.Second):
    return nil, ErrTimeout
case <-ctx.Done():
    return nil, ctx.Err()
}
```

`time.After` 在循环里会泄漏 timer（每次新建），循环内改用：

```go
t := time.NewTimer(2 * time.Second)
defer t.Stop()
for {
    select {
    case r := <-ch:
        return r, nil
    case <-t.C:
        return nil, ErrTimeout
    }
}
```

**背压的实现**：用带缓冲的 channel 作为队列，满了就拒绝而不是阻塞：

```go
select {
case queue <- job:
    return nil            // 入队成功
default:
    return ErrOverloaded  // 队列满，快速失败
}
```

这比"阻塞等待"健康得多：阻塞会把调用方的 goroutine 也拖住，最终整条链路雪崩。

### goroutine 泄漏怎么查

泄漏的三个典型来源：

1. 向已无人接收的 channel 发送（永久阻塞）。
2. 从已无人发送的 channel 接收（永久阻塞）。
3. `http.Response.Body` 未关闭。

检测手段：

```go
// 测试里检查泄漏
import "go.uber.org/goleak"

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}
```

运行期看数量：

```bash
curl -s localhost:6060/debug/pprof/goroutine?debug=1 | head -20
```

数量持续增长就是泄漏。用 `debug=2` 能看到每个 goroutine 的栈，直接定位阻塞点。

### 一组经验数字

| 场景 | 建议并发 |
| --- | --- |
| HTTP 服务每个请求 | 不做后台 goroutine（除非有生命周期管理） |
| 调第三方 API | 按其限流配，通常 5–20 |
| 数据库批量写 | 等于连接池大小（如 10） |
| CPU 密集计算 | `runtime.NumCPU()` 或略多 |

### 一条最容易忽略的纪律

**每个 goroutine 都要能回答"它什么时候退出"**。

回答不了，就是泄漏的候选。写法上强制自己：启动 goroutine 时紧跟一句注释或代码，说明退出条件（ctx 取消、channel 关闭、任务完成）。
