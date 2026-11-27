---
title: 用 Go 写一个生产可用的 HTTP 服务（不是 demo）
description: 从 demo 到生产要补的东西：优雅关闭、超时链、中间件、结构化日志、panic 恢复、健康检查与限流。
date: 2026-11-27
tags: [Go, HTTP, 生产实践]
---

### demo 与生产的差距

```go
// demo：能跑
func main() {
    http.HandleFunc("/", handler)
    http.ListenAndServe(":8080", nil)
}
```

**缺什么**：

```
① 没有超时（慢请求拖死服务）
② 没有优雅关闭（重启时请求中断）
③ 没有日志（出问题查不到）
④ 没有 panic 恢复（一个 panic 打挂整个进程）
⑤ 没有健康检查（容器探针无从判断）
⑥ 没有限流（被打挂）
```

### 完整版本

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
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/hello", withRecover(logger, hello))

	handler := withLogging(logger, withTimeout(30*time.Second, mux))

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,   // 防慢速攻击
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		logger.Info("server starting", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen failed", "err", err)
			os.Exit(1)
		}
	}()

	// 优雅关闭
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("shutdown error", "err", err)
	}
	logger.Info("server exited")
}

func hello(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"msg":"hello"}`))
}
```

### 五个设置的用意

**① 四个超时**

```
ReadHeaderTimeout  防 Slowloris（慢速发头攻击）
ReadTimeout        读完整个请求的上限
WriteTimeout       写响应的上限
IdleTimeout        keep-alive 空闲上限
```

**没有 `ReadHeaderTimeout` 的服务可以被几个连接拖死**（每个连接慢慢发 header，永不结束）。

**② 优雅关闭**

```
srv.Shutdown(ctx)：
- 停止接受新连接
- 等待进行中的请求完成（最多到 ctx 超时）
- 到时间强制关闭
```

**K8s 部署时**：`terminationGracePeriodSeconds` 要大于 shutdown ctx 的超时（给足时间）。

**③ panic 恢复中间件**

```go
func withRecover(logger *slog.Logger, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				logger.Error("panic recovered",
					"panic", rec,
					"path", r.URL.Path,
					"stack", string(debug.Stack()))
				http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
			}
		}()
		next(w, r)
	}
}
```

**`http.Server` 自身会恢复单个连接的 panic**（不会整个进程崩），但：
- 连接会被直接断开（没有 500 响应）
- 没有日志

所以要自己写恢复，返回 500 并记录堆栈。

**④ 结构化日志中间件**

```go
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

func withLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"bytes", rec.bytes,
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", r.Header.Get("X-Request-Id"),
		)
	})
}
```

**JSON 日志的价值**：可以直接被 Loki/ELK 解析，不用正则。

**⑤ 请求超时**

```go
func withTimeout(d time.Duration, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), d)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
```

**注意**：这只是把 ctx 传给下游，**不会自动中断 handler**。handler 里必须检查 `ctx.Done()`：

```go
select {
case <-ctx.Done():
    return ctx.Err()
case result := <-doWork(ctx):
    // ...
}
```

### 限流

```go
import "golang.org/x/time/rate"

limiter := rate.NewLimiter(100, 200)   // 100 rps，突发 200

func withRateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !limiter.Allow() {
			http.Error(w, `{"error":"too many requests"}`, http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

**单机限流 vs 全局限流**：

```
单机（rate.Limiter）→ 多实例时总量 = 实例数 × 单机限额
全局 → 需要 Redis 计数（或用网关限流）
```

**生产建议：网关限流（全局限流）+ 应用限流（保护自己）双层**。

### 健康检查的两种

```
/livez   存活：进程还在跑（不检查依赖）→ 失败则重启
/readyz  就绪：依赖都可用（DB/Redis 连得上）→ 失败则摘流量
```

**混用一个端点是最常见的错误**：

```
如果 /healthz 检查了 DB：
DB 挂 → K8s 重启所有 Pod → 全部重启也没用（DB 还是挂的）
```

**正确做法**：

```go
func readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
}
```

### 启动顺序的两个坑

```
① 在 ListenAndServe 之前阻塞（如等 DB 连上）→ 端口没开，探针判定失败
   → 应该先开端口，就绪由 /readyz 表达

② 优雅关闭时 DB 先关了
   → 应该在 HTTP server Shutdown 之后再关 DB
```

### 检查清单

```
□ ReadHeaderTimeout 已设（防慢速攻击）
□ ReadTimeout / WriteTimeout / IdleTimeout 已设
□ 有优雅关闭（Shutdown + ctx 超时）
□ terminationGracePeriodSeconds > shutdown 超时
□ 有 panic 恢复中间件（返回 500 + 记录堆栈）
□ 结构化 JSON 日志（含 method/path/status/duration/request_id）
□ 有请求超时（ctx 传递 + handler 检查 Done）
□ 有 /livez 与 /readyz 两个端点
□ /readyz 检查依赖，/livez 不检查
□ 限流（单机 + 网关）
□ 先开端口再初始化依赖
□ 关闭时先停 HTTP 再关 DB
```
