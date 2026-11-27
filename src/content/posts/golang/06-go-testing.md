---
title: Go 测试：单测、表驱动、基准与集成测试的分层
description: 测试怎么写才不"为了覆盖率而写"、表驱动与并行、mock 的边界、benchmark 与 pprof 结合、以及 CI 里怎么分层跑。
date: 2026-11-27
tags: [Go, 测试, 基准测试, CI]
---

### 先分层，再写测试

```
单测（毫秒级）   纯逻辑、纯函数、边界条件
组件测试（秒级） 一个模块 + 真实依赖（如内存 DB、临时文件）
集成测试（分钟） 跨服务、真实网络/数据库
端到端（分钟+）  完整链路，通常只在预发跑
```

CI 里分层跑：

```bash
go test ./... -short                 # 单测（用 testing.Short() 跳集成）
go test ./... -run Integration -tags=integration
```

**没有分层的测试会慢到没人跑**，最后全部被 `-skip` 掉。

### 表驱动：Go 里的标准写法

```go
func TestParseDuration(t *testing.T) {
    cases := []struct {
        name    string
        in      string
        want    time.Duration
        wantErr bool
    }{
        {"seconds", "30s", 30 * time.Second, false},
        {"minutes", "5m", 5 * time.Minute, false},
        {"empty", "", 0, true},
        {"negative", "-5s", 0, true},
        {"garbage", "abc", 0, true},
    }

    for _, c := range cases {
        c := c
        t.Run(c.name, func(t *testing.T) {
            t.Parallel()
            got, err := ParseDuration(c.in)
            if (err != nil) != c.wantErr {
                t.Fatalf("err=%v wantErr=%v", err, c.wantErr)
            }
            if got != c.want {
                t.Errorf("got %v want %v", got, c.want)
            }
        })
    }
}
```

要点：

- **`t.Run` + `t.Parallel`**：子测试并行，快，且失败时能定位到具体 case。
- **`c := c`**：Go 1.22 之前必须写（循环变量捕获），1.22+ 可省。
- 每条 case 要有 `name`，否则失败输出是 `TestParseDuration/#03` 这种没法读的东西。

### 该测什么，不该测什么

**该测**：

- 边界条件（空、0、负数、超长、并发）。
- 错误分支（不是只有 happy path）。
- 业务规则（金额计算、状态流转、权限判断）。

**不该测**：

- 第三方库本身（`json.Marshal` 不需要你测）。
- 私有实现的细节（重构就断的测试是负债）。
- 只为了覆盖率的空壳断言。

判断：**测试应该描述"行为契约"，而不是"我现在的实现"**。

### mock 的边界

```go
type Store interface {
    Get(ctx context.Context, id string) (*Order, error)
}

// 测试里实现一个假实现
type fakeStore struct{ data map[string]*Order; err error }
func (f *fakeStore) Get(_ context.Context, id string) (*Order, error) {
    if f.err != nil { return nil, f.err }
    return f.data[id], nil
}
```

原则：

- **只 mock 跨边界的东西**（DB、外部 API、时钟、随机）。
- **不要 mock 自己的内部函数**（说明设计有问题，应该抽接口）。
- 优先用真实实现的轻量替代（sqlite、内存 map）而不是 mock 框架。

### 时钟与随机：可测试性的前提

```go
type Clock interface{ Now() time.Time }

type realClock struct{}
func (realClock) Now() time.Time { return time.Now() }

// 测试用
type fixedClock struct{ t time.Time }
func (f fixedClock) Now() time.Time { return f.t }
```

不注入时钟，所有"过期/重试/限流"逻辑都没法测。

### 基准测试

```go
func BenchmarkJoin(b *testing.B) {
    data := make([]string, 1000)
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _ = strings.Join(data, ",")
    }
}
```

```bash
go test -bench=. -benchmem -count=3
```

三个参数的意义：

- `-benchmem`：显示内存分配（`allocs/op` 往往比 ns/op 更重要）。
- `-count=3`：跑 3 次取稳定性，避免单次抖动。
- `-benchtime=3s`：延长采样。

对比优化前后：

```bash
go test -bench=. -benchmem > old.txt
# 改代码
go test -bench=. -benchmem > new.txt
benchstat old.txt new.txt
```

`benchstat` 会给出变化百分比与显著性，比肉眼比较可靠。

### 覆盖率：用来看，不用来考核

```bash
go test ./... -coverprofile=cover.out
go tool cover -html=cover.out
```

判断标准：

- **核心业务逻辑 70%+** 是合理目标。
- **追求 90%+ 通常换来一堆无意义断言**。
- 覆盖率低的地方优先看"是不是根本没测错误分支"。

### 集成测试的写法

```go
//go:build integration

func TestCreateOrder(t *testing.T) {
    if testing.Short() { t.Skip("skip in short mode") }

    dsn := os.Getenv("TEST_DB_DSN")
    if dsn == "" { t.Skip("no TEST_DB_DSN") }

    db, err := sql.Open("postgres", dsn)
    // ...
    t.Cleanup(func() { truncateAll(db) })
}
```

要点：

- **build tag 隔离**，默认 `go test` 不跑。
- **`t.Cleanup` 清数据**，避免测试间互相污染。
- **缺环境变量就 Skip**，不要让本地开发被卡住。

### 常见反模式

| 反模式 | 问题 |
| --- | --- |
| 测试之间共享全局状态 | 顺序依赖，并行就挂 |
| `time.Sleep` 等待 | 慢且不稳（应轮询到条件满足） |
| 断言错误字符串 | 改文案就断 |
| 一个测试断言 20 件事 | 失败时不知道哪坏了 |
| 只有 happy path | 错误分支从未被验证 |
