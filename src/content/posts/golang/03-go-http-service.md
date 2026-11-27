---
title: 用 Go 写一个能上线的 HTTP 服务（不含框架）
description: 从 net/http 起步：路由与中间件、配置与日志、超时与优雅关闭、健康检查、单测与 Dockerfile，全篇只用标准库，讲清楚每一步为什么这么做。
date: 2022-04-19
tags: [Go, HTTP, 后端, 工程化, 部署]
---

### 为什么不从框架开始

Go 的 `net/http` 已经是一个完整的生产级服务器：连接管理、超时、TLS、HTTP/2 都在里面。框架多给你的是"路由参数"和"中间件链"，而这两件事用标准库写一次也就几十行。

先掌握标准库，再评估要不要框架，判断会准得多。

### 最小但结构正确的骨架

```
cmd/server/main.go     # 入口：配置、依赖、启动、优雅退出
internal/api/router.go # 路由注册
internal/api/handler.go# 业务处理
internal/config/config.go
```

`main.go`：

```go
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"example.com/demo/internal/api"
	"example.com/demo/internal/config"
)

func main() {
	cfg := config.Load()

	mux := http.NewServeMux()
	api.Register(mux)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.WithMiddleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		slog.Info("server starting", "addr", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen failed", "err", err)
			os.Exit(1)
		}
	}()

	// 优雅关闭：先停止接收新连接，再等存量请求结束
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown failed", "err", err)
	}
	slog.Info("server stopped")
}
```

四个超时都有明确理由：

- `ReadHeaderTimeout`：防慢速攻击（Slowloris），只发 header 不发 body。
- `ReadTimeout`：读完整个请求体的上限。
- `WriteTimeout`：从读完请求到写完响应的上限。**注意它对流式接口不友好**，长连接推送要单独处理。
- `IdleTimeout`：keep-alive 空闲回收。必须小于上游（Nginx/LB）的空闲超时，否则会出现"上游以为连接还在，实际已被对端关闭"的间歇性 502。

`WriteTimeout` 与 `IdleTimeout` 的关系这里值得记一笔：**`IdleTimeout` 要短于 Nginx 的 `keepalive_timeout`**。反了就会踩到著名的 "connection reset by peer"。

### 路由：Go 1.22 之后自带路径参数

```go
mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
})

mux.HandleFunc("GET /api/v1/orders/{id}", func(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")     // 标准库直接支持
	...
})

mux.HandleFunc("POST /api/v1/orders", createOrder)
```

方法 + 路径的组合写法，天然区分 `GET` 与 `POST`，不用再手写 `if r.Method != ...`。

### 中间件：一个函数包一层

```go
type Middleware func(http.Handler) http.Handler

func Chain(h http.Handler, mws ...Middleware) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// 请求日志 + request id
func Logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rid := r.Header.Get("X-Request-Id")
		if rid == "" {
			rid = newID()
		}
		w.Header().Set("X-Request-Id", rid)

		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)

		slog.Info("http",
			"rid", rid, "method", r.Method, "path", r.URL.Path,
			"status", rec.status, "dur_ms", time.Since(start).Milliseconds(),
			"ua", r.UserAgent())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}
```

注意 `statusRecorder` 要保留 `Flush()` 和 `Hijack()` 的透传（流式/WebSocket 场景），否则会断。简单做法是给它加 `Flush()` 方法转发给底层 writer。

还有两个必备中间件：

- **Recover**：`defer recover()` 把 panic 转成 500 + 日志，**不要**把 panic 交给 `net/http` 默认处理（它会直接断连接，客户端看到的是空响应）。
- **超时**：`http.TimeoutHandler` 或 `r.Context()` 里的 deadline，防止某个慢请求把 goroutine 挂死。

### 配置：环境变量优先

```go
type Config struct {
	Addr    string
	DBDSN   string
	LogLevel slog.Level
}

func Load() Config {
	return Config{
		Addr:  getenv("APP_ADDR", ":8080"),
		DBDSN: os.Getenv("APP_DB_DSN"),
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
```

配置文件适合"多环境多字段"，环境变量适合"容器化部署"。两者混用时，**环境变量覆盖文件**。

### 健康检查分两种，别混

- **liveness**：`/healthz` 只检查进程活着（能返回 200 就行）。**不要在里面查数据库**——数据库抖一下会把整个集群的 Pod 全重启。
- **readiness**：`/readyz` 检查依赖是否就绪（DB 连接、缓存、下游）。可以在这里做简单探测，超时就返回 503，让流量先别进来。

```go
mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		http.Error(w, "db not ready", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
})
```

### 单测：httptest 就够了

```go
func TestCreateOrder(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/v1/orders", strings.NewReader(`{"sku":"A1","qty":2}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	mux := http.NewServeMux()
	Register(mux)
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d body=%s", w.Code, w.Body.String())
	}
}
```

不需要起真实端口，`httptest` 让 handler 变成纯函数，跑得又快又稳。

### Dockerfile：静态二进制 + distroless

```dockerfile
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/app"]
```

`CGO_ENABLED=0` 得到完全静态的二进制，用 `FROM scratch` 也能跑。加上 `-ldflags="-s -w"` 能减 30% 体积。镜像最终 10MB 量级，启动毫秒级。

### 上线前自查五条

1. 四个超时都设了，且 `IdleTimeout` < 上游 keepalive。
2. 中间件里有 recover，且日志带 request id。
3. liveness 不查依赖，readiness 查依赖。
4. 优雅关闭走完 `Shutdown`，别用 `os.Exit` 直接砍。
5. 二进制是静态的，容器以非 root 运行。

### 一句话总结

Go 的 HTTP 服务不需要框架就能上线，前提是把**超时、优雅关闭、健康检查、panic 恢复**这四件事写对——它们都在标准库里，也都在上线后最容易出问题的地方。
