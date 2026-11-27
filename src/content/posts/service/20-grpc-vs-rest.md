---
title: gRPC 还是 REST：微服务之间到底用什么
description: 两者的真实差别、性能数据背后的前提、gRPC 的六个运维难点、以及"内网 gRPC + 对外 REST"的混合方案。
date: 2025-06-28
tags: [gRPC, REST, 微服务, 选型]
---

### 一句话差别

```
REST：HTTP + JSON，人能看懂，任何工具都能调
gRPC：HTTP/2 + Protobuf，二进制，需 schema，工具链要求高
```

### 性能差距的真相

**常见的说法**："gRPC 比 REST 快 10 倍"。

**实际前提**：

```
① 大 payload（Protobuf 序列化优势明显）
② 高 QPS（HTTP/2 多路复用 + 连接复用）
③ 低延迟要求（二进制解析快）
```

**如果**：

```
payload 很小（几百字节）+ 内网 + QPS 不高
→ 差距可能只有 10–20%，不值得引入复杂度
```

**"快 10 倍"的测试往往是"序列化对比"**，不是端到端。

### gRPC 的六个运维难点

**① 调试难**

```bash
# REST 调试
curl https://api/users/1

# gRPC 调试
grpcurl -plaintext -d '{"id":1}' localhost:50051 user.UserService/GetUser
```

需要 `grpcurl` 或 `grpcui`，且要拿到 proto 文件（或开 reflection）。

**② 负载均衡**

```
gRPC 用 HTTP/2 长连接 → 连接级 LB 会把流量集中到少数后端
→ 需要"请求级 LB"（如 Envoy、Linkerd、Nginx 的 grpc_pass + 每请求路由）
```

**这是最常见的坑**：L4 LB 后面挂 4 个实例，结果 90% 流量打到 1 个。

**③ 超时与重试**

```go
ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
defer cancel()
resp, err := client.GetUser(ctx, req)
```

**`context` 必须传**。忘了传就没超时（会一直挂着）。

**④ 错误处理**

```
gRPC 错误码是有限的枚举（NotFound/InvalidArgument/Unavailable...）
不是 HTTP 状态码

需要把业务错误码映射进去（或用 details 扩展）
```

**⑤ 版本兼容**

```
Protobuf 的兼容规则：
- 字段编号不能复用（复用 = 数据错乱）
- 不能改字段类型
- 删除字段要用 reserved 标记编号
```

```protobuf
message User {
  reserved 3, 5;              // 已删除的编号，禁止复用
  reserved "old_name";        // 已删除的字段名
  int64 id = 1;
  string name = 2;
}
```

**⑥ 中间件生态**

```
认证、限流、日志、链路追踪：gRPC 生态比 HTTP 少
很多工具（WAF、网关、抓包）对 HTTP/2 支持不完整
```

### REST 的四个坑（也别美化它）

```
① 没有强 schema（OpenAPI 是后加的约定，不是强约束）
② 字段变更靠"约定"（改名/删字段容易把客户端弄崩）
③ 大 payload 的 JSON 解析开销
④ 每个请求都要传一堆 header（HTTP/2 有 HPACK 缓解）
```

### 混合方案（多数公司的实际选择）

```
对外（浏览器/第三方）→ REST + JSON（或 GraphQL）
内部服务之间（高频、结构化）→ gRPC
```

**为什么这样分**：

```
对外要"易接入" → REST
对内要"高效 + 强类型" → gRPC
```

**网关做协议转换**（如 grpc-gateway）：

```protobuf
service UserService {
  rpc GetUser(GetUserRequest) returns (User) {
    option (google.api.http) = {
      get: "/v1/users/{id}"
    };
  }
}
```

**一个 proto 同时生成 gRPC 服务与 REST 接口**，对外提供 JSON，对内走 gRPC。

### 什么时候真的该用 gRPC

```
① 服务之间调用量大（QPS > 数千）
② payload 较大（> 10KB）或结构复杂
③ 需要流式（server streaming / bidirectional）
④ 多语言（Go/Java/Python 混用，proto 生成各语言客户端）
⑤ 需要强 schema 与兼容性保障
```

**流式是 gRPC 的独特能力**：

```
REST 做流式要靠 SSE/WebSocket 自己搭
gRPC 原生支持四种：一元、服务端流、客户端流、双向流
```

### 什么时候用 REST 更好

```
① 对外 API（客户/第三方）
② 简单 CRUD，QPS 不高
③ 团队不熟 gRPC（学习成本会拖慢交付）
④ 需要被浏览器直接调用（gRPC-Web 要额外代理）
⑤ 需要被各种工具直接调（curl/Postman）
```

### 一个务实的判断流程

```
1. 这个接口给谁用？
   浏览器/第三方 → REST
   内部服务 → 继续

2. QPS 与 payload？
   QPS < 1000 且 payload 小 → REST 也够
   否则 → gRPC 有优势

3. 需要流式吗？
   需要 → gRPC

4. 团队会 gRPC 吗？
   不会且时间紧 → REST（先做对，再优化）
```

### 检查清单

```
□ 明确"对外 REST / 对内 gRPC"的分工
□ gRPC 用请求级 LB（不只是 L4）
□ context 超时全部传下去
□ 错误码有映射规范（业务码 ↔ gRPC code）
□ proto 用 reserved 保护已删字段
□ 有 grpcurl/grpcui 方便调试
□ 开 reflection（便于工具发现服务）
□ 中间件（认证/限流/trace）有对应方案
□ 不为了"快 10 倍"引入不需要的复杂度
```
