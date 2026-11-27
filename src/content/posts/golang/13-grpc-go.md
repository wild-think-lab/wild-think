---
title: Go 写 gRPC 服务：从 proto 到能上线
description: proto 设计、代码生成、拦截器、超时与重试、五个"本地通线上不通"的原因。
date: 2026-11-27
tags: [Go, gRPC, 服务]
---

### 一、先定 proto（接口即契约）

```proto
syntax = "proto3";
package order.v1;

option go_package = "example.com/order/api/order/v1;orderv1";

message CreateOrderRequest {
  string user_id = 1;
  repeated Item items = 2;
  string idempotency_key = 3;   // 幂等键
}
message CreateOrderResponse {
  string order_id = 1;
  int32 status = 2;
}

service OrderService {
  rpc CreateOrder(CreateOrderRequest) returns (CreateOrderResponse);
  rpc GetOrder(GetOrderRequest) returns (GetOrderResponse);
}
```

**约定**：

```
① 包名带版本（order.v1），升级不破坏老客户端
② 字段编号不复用（删字段要 reserved）
③ 幂等键放在请求体（不要靠 header 猜）
```

### 二、代码生成

```bash
protoc --go_out=. --go_opt=paths=source_relative \
       --go-grpc_out=. --go-grpc_opt=paths=source_relative \
       proto/order/v1/order.proto
```

**建议**：把生成命令写进 `Makefile`，并在 CI 校验"生成物与源一致"（避免有人手改）。

### 三、服务端最小实现

```go
type server struct{ orderv1.UnimplementedOrderServiceServer }

func (s *server) CreateOrder(ctx context.Context, req *orderv1.CreateOrderRequest) (*orderv1.CreateOrderResponse, error) {
	if req.GetUserId() == "" {
		return nil, status.Error(codes.InvalidArgument, "user_id required")
	}
	if req.GetIdempotencyKey() != "" {
		if id, ok := s.cache.Get(req.GetIdempotencyKey()); ok {
			return &orderv1.CreateOrderResponse{OrderId: id}, nil
		}
	}
	id, err := s.store.Create(ctx, req)
	if err != nil {
		return nil, status.Error(codes.Internal, "create failed")
	}
	return &orderv1.CreateOrderResponse{OrderId: id}, nil
}

func main() {
	lis, _ := net.Listen("tcp", ":9090")
	s := grpc.NewServer(
		grpc.ChainUnaryInterceptor(logging, recovery, timeout(5*time.Second)),
	)
	orderv1.RegisterOrderServiceServer(s, &server{})
	s.Serve(lis)
}
```

**"错误要带 code"**（`codes.InvalidArgument`），不要返回裸 error（客户端无法区分）。

### 四、拦截器

```go
func timeout(d time.Duration) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, h grpc.UnaryHandler) (any, error) {
		ctx, cancel := context.WithTimeout(ctx, d)
		defer cancel()
		return h(ctx, req)
	}
}

func recovery(ctx context.Context, req any, info *grpc.UnaryServerInfo, h grpc.UnaryHandler) (resp any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = status.Error(codes.Internal, "panic")
		}
	}()
	return h(ctx, req)
}
```

**recovery 必须有**：一个 panic 会让整个进程退出。

### 五、客户端：超时、重试、连接复用

```go
conn, err := grpc.DialContext(ctx, "order-svc:9090",
	grpc.WithTransportCredentials(insecure.NewCredentials()),
	grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(16<<20)),
	grpc.WithChainUnaryInterceptor(retryInterceptor))
defer conn.Close()
```

**要点**：

```
① conn 要复用（不要每次请求 Dial）
② 每次调用带 context 超时
③ 重试只对"幂等操作"（Create 要有幂等键）
```

### 六、五个"本地通线上不通"

**① 用了 insecure 凭证但线上要 TLS**

```
本地明文没问题，线上必须 creds
```

**② 消息超过默认大小（4MB）**

```
gRPC 默认 4MB → 大响应被拒
→ 设 MaxRecvMsgSize，或改分页
```

**③ 负载均衡没开**

```
k8s 默认按 TCP 长连接 → 只有一个 Pod 收到流量
→ 用 headless svc + 客户端 LB，或服务端 keepalive 短连接
```

**④ 代理/网关不支持 HTTP/2**

```
Nginx 要 http2 + grpc_pass（不是 proxy_pass）
```

**⑤ keepalive 参数被中间设备重置**

```
60s 空闲被防火墙断 → 设 keepalive + 重连
```

### 七、可观测

```
① 每次调用记录 method / code / duration
② 服务端暴露 Prometheus 指标（按 method 分）
③ 链路追踪（metadata 传 trace id）
```

### 检查清单

```
□ proto 带版本包名
□ 生成命令在 Makefile，CI 校验
□ 错误统一用 status code
□ 有 recovery 拦截器
□ 有超时拦截器
□ 客户端复用 conn
□ 重试仅幂等
□ 大消息上限明确
□ HTTP/2 与网关配置正确
□ 负载均衡方案明确
□ 有 method 级指标
□ 有 trace id 透传
```
