---
title: Go 并发怎么写才不出事：goroutine、context 与限流
description: 并发不是开得越多越快。讲清 goroutine 的生命周期、context 取消传播、WaitGroup 与信号量限流，附一个并发采集器的正确写法。
date: 2022-01-15
tags: [Go, 并发, context, 工程实践]
---

### 一句话原则

**每个 goroutine 都要有明确的退出条件。**没有退出条件的 goroutine 就是内存泄漏 + 潜在的 panic 源。

### 反面例子：教科书写法在生产中的问题

```go
for _, host := range hosts {   // 200 台机器
	go check(host)             // 同时起 200 个连接
}
```

问题：

- 同时 200 个 TCP 连接 + 200 个 goroutine，本地 fd 可能不够，对端也可能限流。
- 没有任何超时，卡住的 goroutine 永久存活。
- 主函数可能在 goroutine 还没跑完时退出，结果随机。

### 正确写法：限流 + 超时 + 等待

```go
package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

func checkAll(ctx context.Context, hosts []string, workers int, timeout time.Duration) []error {
	sem := make(chan struct{}, workers)   // 信号量，限制并发数
	var wg sync.WaitGroup
	errs := make([]error, len(hosts))
	var mu sync.Mutex

	for i, h := range hosts {
		wg.Add(1)
		sem <- struct{}{}                // 占一个槽位，满了就阻塞
		go func(i int, host string) {
			defer wg.Done()
			defer func() { <-sem }()      // 释放槽位

			c, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()

			if err := check(c, host); err != nil {
				mu.Lock()
				errs[i] = fmt.Errorf("%s: %w", host, err)
				mu.Unlock()
			}
		}(i, h)
	}

	wg.Wait()
	return errs
}
```

要点逐条：

- `sem`（带缓冲 channel）控制并发数，写 20 就最多 20 个在跑。
- 每个任务有独立 `context.WithTimeout`，超时自动结束，不会永久挂住。
- `errs[i]` 按下标写入，避免加锁也能保序（这里仍加锁，防数据竞争）。
- `wg.Wait()` 保证"所有任务结束才返回"。

### context 的传播规则

```go
ctx, cancel := context.WithCancel(context.Background())
defer cancel()                        // 一定要 defer，否则泄漏

ctx = context.WithValue(ctx, "traceID", id)   // 只放请求级元数据，别放业务参数
```

- 取消会**向下传播**：父 ctx 取消，所有子 ctx 一起取消。
- `context.Value` 只用于 traceID、用户 ID 这类横切数据，不要拿它传配置。
- HTTP handler 里用 `r.Context()`，客户端断开时请求会被取消，省掉无用功。

### 两种常见陷阱

**1. 循环变量捕获**

Go 1.22 起 for 循环变量每轮新建，不会再踩这个坑；但如果你在 1.21 及以前，`go func(){ use(v) }()` 会共享同一个 `v`。老版本必须显式传参。

**2. 无缓冲 channel 的死锁**

```go
ch := make(chan int)      // 无缓冲
ch <- 1                   // 没有接收者，永久阻塞
```

要么给缓冲 `make(chan int, 10)`，要么保证有接收方。

### 用 select 做超时与优雅退出

```go
select {
case res := <-resultCh:
	fmt.Println("done:", res)
case <-time.After(30 * time.Second):
	fmt.Println("timeout")
case <-ctx.Done():
	fmt.Println("cancelled:", ctx.Err())
}
```

一个 worker 循环的退出写法：

```go
for {
	select {
	case <-ctx.Done():
		return
	case job, ok := <-jobs:
		if !ok {
			return           // channel 已关闭
		}
		process(job)
	}
}
```

### 实战：一个并发 SSH 巡检工具（骨架）

```go
type result struct {
	Host string
	OK   bool
	Msg  string
}

func run(ctx context.Context, hosts []string) []result {
	out := make(chan result, len(hosts))
	sem := make(chan struct{}, 10)
	var wg sync.WaitGroup

	for _, h := range hosts {
		wg.Add(1)
		sem <- struct{}{}
		go func(h string) {
			defer wg.Done()
			defer func() { <-sem }()
			c, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			// ... ssh 执行 uptime，读输出
			out <- result{Host: h, OK: true, Msg: "up"}
			_ = c
		}(h)
	}

	go func() { wg.Wait(); close(out) }()   // 关闭 channel 交给独立 goroutine

	var rs []result
	for r := range out {
		rs = append(rs, r)
	}
	return rs
}
```

关键在 `wg.Wait()` 与 `close(out)` 放在同一个 goroutine 里：所有写入结束后才关 channel，`range` 才能安全退出。

### 排查并发问题的手段

```bash
go run -race .              # 数据竞争检测，CI 必跑
go vet ./...
GODEBUG=gctrace=1 ./app     # 观察 GC 压力
```

`-race` 是性价比最高的工具：它能在测试阶段抓出绝大多数"偶发数据错乱"。

### 结论

Go 的并发不是"开 goroutine 就完了"，三件事必须成对出现：

- 起 goroutine 时 → 有 `wg` 或 `ctx` 管它。
- 调用外部服务时 → 有超时。
- 共享数据时 → 有锁或走 channel。

做到这三条，你的采集器、巡检工具、小服务就能长期稳定跑在线上。
