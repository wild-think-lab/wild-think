---
title: gRPC 速查
summary: 常用 grpcurl 调试、proto 生成命令、错误码对照、超时与 keepalive 参数。
group: service
order: 1
tags: [gRPC, 服务, 调试]
---

### 生成代码

```bash
protoc --go_out=. --go_opt=paths=source_relative \
       --go-grpc_out=. --go-grpc_opt=paths=source_relative \
       order.proto

# 带 grpc-gateway
protoc --grpc-gateway_out=. --grpc-gateway_opt=paths=source_relative order.proto
```

### 用 grpcurl 调接口（不用写客户端）

```bash
grpcurl -plaintext localhost:9090 list
grpcurl -plaintext localhost:9090 list order.v1.OrderService
grpcurl -plaintext localhost:9090 describe order.v1.CreateOrderRequest
grpcurl -plaintext -d '{"user_id":"u1"}' localhost:9090 order.v1.OrderService/CreateOrder

# 带 metadata（认证）
grpcurl -H 'authorization: Bearer xxx' -d @ localhost:9090 order.v1.OrderService/GetOrder <<'JSON'
{"order_id":"o1"}
JSON

# TLS
grpcurl -cacert ca.pem -servername example.com example.com:443 list
```

### 错误码对照

```
OK                 成功
InvalidArgument    参数错（客户端问题）
NotFound           不存在
AlreadyExists      重复
PermissionDenied   无权限
Unauthenticated    未认证
ResourceExhausted  限流/配额
Unavailable        依赖不可用（可重试）
DeadlineExceeded   超时（可重试）
Internal           服务端 bug
```

**重试判据**：`Unavailable` / `DeadlineExceeded` 可重试；其余不要无脑重试。

### 服务端关键参数

```go
grpc.NewServer(
  grpc.MaxRecvMsgSize(16<<20),
  grpc.KeepaliveParams(keepalive.ServerParameters{
    MaxConnectionIdle: 5*time.Minute,
    Time: 30*time.Second,
    Timeout: 10*time.Second,
  }),
)
```

### 客户端关键参数

```go
grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(16<<20))
grpc.WithKeepaliveParams(keepalive.ClientParameters{
  Time: 30*time.Second, Timeout: 10*time.Second, PermitWithoutStream: true,
})
```

### Nginx 反代 gRPC

```nginx
location / {
  grpc_pass grpc://backend:9090;
  grpc_read_timeout 60s;
  grpc_send_timeout 60s;
}
```

### 判据表

| 现象 | 首查 |
| --- | --- |
| `ResourceExhausted` | 消息过大（4MB 默认） |
| `Unavailable` + 只有一个 Pod 有流量 | 负载均衡（长连接） |
| `DeadlineExceeded` | 客户端超时太短 / 服务端慢 |
| 503 且 nginx 日志报 h2 错 | 用了 proxy_pass 而非 grpc_pass |
| 空闲断开 | keepalive 与中间设备超时 |

### 坑

```
① 每次请求都 Dial → 连接风暴（要复用）
② 没设超时 → 堆积
③ 没 recovery 拦截器 → panic 直接退进程
④ 明文凭证上生产
⑤ 大响应不分页
```
