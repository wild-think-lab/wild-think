---
title: Go 项目目录结构：别一开始就搞"标准布局"
description: 三种规模的目录方案、internal 的真正作用、cmd 与 main 的关系、依赖注入放在哪，以及"包名与目录名不一致"的坑。
date: 2026-11-27
tags: [Go, 工程化, 目录结构, 架构]
---

### 三种规模

**小型（单服务，< 20 个文件）**：

```
myapp/
├── go.mod
├── main.go
├── handler.go
├── store.go
└── handler_test.go
```

一个包搞定。**这是最该先用的方案**，很多人一上来就分层，结果全是循环引用。

**中型（有明确边界）**：

```
myapp/
├── cmd/
│   └── server/
│       └── main.go          ← 只做装配，不写业务
├── internal/
│   ├── api/                 ← HTTP 层（handler、路由、DTO）
│   ├── service/             ← 业务逻辑
│   ├── store/               ← 数据访问（接口 + 实现）
│   └── config/              ← 配置加载
├── pkg/                     ← 可以被外部引用的（可选）
└── go.mod
```

**大型/多服务**：

```
repo/
├── cmd/{api,worker,cli}/
├── internal/
│   ├── domain/              ← 领域模型（无外部依赖）
│   ├── app/                 ← 用例编排
│   ├── infra/               ← DB、MQ、外部 API 适配器
│   └── transport/           ← HTTP/gRPC
├── api/                     ← protobuf / OpenAPI 定义
├── migrations/
└── deploy/
```

### internal 的真正作用

`internal/` 下的包**只能被同一模块内引用**，外部模块无法 import。

```go
// 别的项目 import github.com/you/myapp/internal/store → 编译错误
```

它的价值不是"看起来规范"，而是**强制边界**：你重构内部实现时，不用担心外部有人在用。

**规则**：默认所有业务代码放 `internal/`，只有确实要给外部用的才放 `pkg/`（或者直接叫别的名字，`pkg` 只是习惯）。

### cmd 与 main 的关系

`cmd/` 下每个子目录对应一个可执行文件，`main.go` 只做三件事：

```go
func main() {
    cfg := config.Load()                 // 1. 读配置
    app, err := app.New(cfg)             // 2. 装配依赖
    if err != nil { log.Fatal(err) }
    if err := app.Run(context.Background()); err != nil {  // 3. 启动
        log.Fatal(err)
    }
}
```

**不要在 main 里写业务逻辑**，也不要让 `main` 包被任何包引用（引用不了，但有人会把逻辑写进 main 然后别处复制）。

### 依赖注入放哪

三种做法：

**① 构造函数注入（最常见）**

```go
type Service struct {
    store Store
    cache Cache
}

func NewService(s Store, c Cache) *Service {
    return &Service{store: s, cache: c}
}
```

在 `cmd/server/main.go` 里手工装配：

```go
store := postgres.New(db)
cache := redis.NewClient(addr)
svc := service.New(store, cache)
h := api.NewHandler(svc)
```

**② wire/fx 自动生成**：依赖多时省事，但增加构建复杂度。

**③ 全局变量**：简单项目可用，但测试时难以替换。**不推荐在 service 层用**。

### 接口放哪（关键细节）

**接口应该定义在"使用方"，而不是"实现方"**。

```go
// internal/service/service.go —— 使用方定义接口
type Store interface {
    GetUser(ctx context.Context, id string) (User, error)
}

// internal/store/postgres/user.go —— 实现方返回具体类型
func (s *PG) GetUser(ctx context.Context, id string) (domain.User, error)
```

好处：service 不依赖 store 包，可以独立测试（用假实现）。

反例：在 `store` 包里定义 `UserStore interface`，然后 `service` import 它 → service 被迫依赖 store，测试时必须起数据库。

### "包名与目录名不一致"的坑

Go 的约定是**包名 = 目录名**（但不强制）。不一致会出现：

```go
import "github.com/you/app/internal/store/postgres"
postgres.New(...)   // 而实际包名是 pg
```

IDE 与工具会困惑，人也会困惑。**除了版本化目录（v2），保持包名 = 目录名**。

另一个坑：**包名不要与关键字冲突**（`type`、`func`、`range` 等），也不要与变量名重名。

### 测试文件怎么放

```
同包里放 xxx_test.go（白盒，能测私有函数）
单独 xxx_test 包（黑盒，只测公开 API）
```

对外提供的库用黑盒测试；内部服务用白盒更实用。

```go
// service_test.go
package service            // 白盒

// 或
package service_test       // 黑盒，import "…/service"
```

### 一个真实的重构

初始结构（1 个包，2000 行）：

```
app.go  ← 所有东西都在里面
```

问题：改一个查询要等整个包编译 + 测试全跑，且循环依赖无法解决。

分三步：

```
第 1 步：按"数据访问 / 业务 / 接口"拆三个子包
         （只移动代码，不改逻辑）
第 2 步：在业务层定义接口，数据层实现
第 3 步：main 里装配，删除包级全局变量
```

结果：单测从"必须起数据库"变成"用内存假实现"，跑一次 0.2 秒。

### 检查清单

```
□ 小项目先用单包，别过度分层
□ 业务代码默认放 internal/
□ main 只做装配，不写业务
□ 接口定义在使用方
□ 包名 = 目录名
□ 依赖通过构造函数传入，测试可替换
□ 有 migrations / deploy 等配套目录
```
