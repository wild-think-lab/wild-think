---
title: Go 测试：从"为了覆盖率"到"真的能防回归"
description: 表驱动测试、mock 的边界、并发与超时测试、集成测试组织，以及五个"测试很多但线上照样挂"的原因。
date: 2026-11-27
tags: [Go, 测试, 工程化]
---

### 表驱动 + t.Run

```go
func TestParseDuration(t *testing.T) {
    cases := []struct {
        name string
        in   string
        want time.Duration
        err  bool
    }{
        {"seconds", "30s", 30 * time.Second, false},
        {"minutes", "2m", 2 * time.Minute, false},
        {"invalid", "abc", 0, true},
        {"empty", "", 0, true},
    }
    for _, c := range cases {
        t.Run(c.name, func(t *testing.T) {
            got, err := ParseDuration(c.in)
            if (err != nil) != c.err {
                t.Fatalf("err=%v wantErr=%v", err, c.err)
            }
            if got != c.want {
                t.Fatalf("got=%v want=%v", got, c.want)
            }
        })
    }
}
```

**"表驱动"** 让"新增一个用例"只加一行（维护成本最低）。

### 断言的写法

```go
if got != want {
    t.Fatalf("ParseDuration(%q) = %v, want %v", c.in, got, c.want)
}
```

**"报错带输入和期望"** 是能省最多时间的习惯。

**`t.Fatalf` vs `t.Errorf`**：

```
Fatalf：当前用例立即终止（后续依赖上一步结果时用）
Errorf：继续跑（能一次看到多个失败）
```

### mock 的边界

```
① 只 mock"外部依赖"（DB/HTTP/时间/随机）
② 不要 mock"自己的业务函数"（那等于测了个假实现）
③ 用接口注入，不用 monkey patch
```

```go
type Clock interface{ Now() time.Time }

type Service struct{ clock Clock }
```

**"为了 mock 把代码拆得更烂"** 是过度设计的信号。

### 并发与超时测试

```go
func TestConcurrentAccess(t *testing.T) {
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() { defer wg.Done(); _ = cache.Get("k") }()
    }
    wg.Wait()
}
```

**"跑 -race"**：

```bash
go test -race ./...
```

**"数据竞争只有在 -race 下才暴露"** —— CI 必须带 `-race`。

**超时**：

```go
ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
defer cancel()
```

**"测超时行为"** 比"测正常路径"更能发现 bug。

### 集成测试怎么组织

```
① 用 build tag 隔离：`//go:build integration`
② 用 testcontainers 起真实依赖
③ CI 里"单测先跑，集成测试后跑"
```

```bash
go test -tags=integration ./...
```

**"集成测试和单测混在一起"** → 单测跑得慢，没人愿意跑。

### 五个"测试很多但线上照样挂"

**① 只测 happy path**

```
没有"空值/错误/超时/并发"的用例
```

**② 断言太弱**

```go
if err != nil { t.Fatal(err) }   // 什么内容都没验
```

**③ mock 掩盖了真实行为**

```
mock 返回"理想数据"，真实依赖返回"带空格的字符串"
```

**④ 没有 -race**

```
并发 bug 在本地永远看不到
```

**⑤ 测试依赖顺序/全局状态**

```
A 测试改了全局变量，B 测试挂了（顺序敏感）
→ 每个测试要独立
```

### 覆盖率怎么看

```bash
go test -coverprofile=cover.out ./...
go tool cover -func=cover.out | tail -1
go tool cover -html=cover.out
```

**"80% 覆盖率但关键分支没测"** 很常见：

```
看"未覆盖的行"比看"总覆盖率"更有价值
```

### 一个"能防回归"的测试清单

```
□ 表驱动（含错误/边界用例）
□ 断言带输入与期望
□ 外部依赖用接口 mock
□ CI 带 -race
□ 有超时与并发用例
□ 集成测试用 tag 隔离
□ 测试相互独立（无全局状态）
□ 覆盖率看"未覆盖行"而非数字
□ 关键 bug 修复要补一个"会失败的测试"
```

**"修 bug 先写一个能复现的测试"** 是最有效的防回归手段。

### 检查清单

```
□ 表驱动 + t.Run 命名
□ 断言信息完整
□ 只 mock 外部依赖
□ -race 在 CI
□ 有超时/并发/错误用例
□ 集成测试隔离（tag）
□ 测试独立
□ 关注未覆盖行
□ 每个线上 bug 补测试
```
