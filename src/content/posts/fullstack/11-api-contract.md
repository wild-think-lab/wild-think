---
title: 前端与后端的分工边界：接口契约怎么写才不吵架
description: 契约先行的做法、字段与错误码的规范、分页与幂等的约定、版本演进策略，以及"前后端联调三天"的根因。
date: 2026-11-27
tags: [前端, 后端, API, 协作]
---

### "联调三天"的四个根因

```
① 字段名不一致（后端 user_name，前端 username）
② 类型不一致（后端返回 "1"，前端当布尔用）
③ 空值处理不一致（后端 null，前端当空字符串）
④ 错误结构不一致（每个接口错误格式都不一样）
```

这四个都是**契约没定清**导致的，不是"技术问题"。

### 契约先行

**顺序**：

```
① 先写 OpenAPI/接口文档（字段、类型、示例、错误码）
② 后端按文档实现，前端按文档 mock
③ 双方用同一份文档做联调（不一致就是文档的错）
```

OpenAPI 片段：

```yaml
paths:
  /api/v1/orders:
    get:
      parameters:
      - name: page
        in: query
        schema: { type: integer, minimum: 1, default: 1 }
      - name: page_size
        in: query
        schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderList'
        '401':
          $ref: '#/components/responses/Unauthorized'
components:
  schemas:
    Order:
      type: object
      required: [id, status, amount, created_at]
      properties:
        id: { type: string }
        status: { type: string, enum: [pending, paid, shipped, closed] }
        amount: { type: integer, description: "单位：分" }
        created_at: { type: string, format: date-time }
```

**从文档生成 mock 与客户端**：

```bash
npx @stoplight/prism-cli mock openapi.yaml    # 起 mock server
npx openapi-typescript openapi.yaml -o types.ts   # 前端生成类型
```

### 字段规范的六条

```
① 命名统一：JSON 用 snake_case 或 camelCase，全站一致
② 金额用整数（分），不用浮点
③ 时间用 ISO8601 带时区字符串
④ 布尔用 true/false，不用 0/1/"1"
⑤ 空值统一用 null，不用 "" 或 "null"
⑥ ID 一律用字符串（避免 JS 大整数精度丢失）
```

第⑥条很实际：`9007199254740993` 这种 ID 在 JS 里会变成 `9007199254740992`。

### 错误结构统一

```json
{
  "error": {
    "code": "ORDER_NOT_FOUND",
    "message": "订单不存在",
    "request_id": "req_abc123",
    "details": {"order_id": "o_8891"}
  }
}
```

要点：

```
① code 是机器可读的（前端按 code 判断，不解析 message）
② message 给人看（可直接展示给用户）
③ request_id 用于查日志
④ HTTP 状态码与 code 语义一致（404 配 NOT_FOUND）
```

**前端只依赖 code**，后端可以改 message 文案而不破坏前端。

### 分页的三层约定

```
① 参数：page/page_size（或 cursor/limit）
② 返回：items + total + has_more
③ 上限：page_size 有最大值（如 100），防止拖库
```

```json
{
  "items": [...],
  "page": 2,
  "page_size": 20,
  "total": 1532,
  "has_more": true
}
```

**大数据量用 cursor 分页**（避免 `OFFSET 10000` 的全扫）：

```
GET /orders?cursor=eyJpZCI6ODg5MX0&limit=20
→ {"items":[...], "next_cursor":"eyJpZCI6ODkwMX0"}
```

### 幂等

**创建类接口必须支持幂等**（网络重试、用户双击）：

```
方案：客户端带 Idempotency-Key
服务端：key + 请求指纹存 Redis，24 小时内重复请求返回首次结果
```

```http
POST /api/v1/payments
Idempotency-Key: 5f2c1a9e-...
```

```python
def create_payment(key, payload):
    cached = redis.get(f"idem:{key}")
    if cached:
        return json.loads(cached)
    result = do_create(payload)
    redis.setex(f"idem:{key}", 86400, json.dumps(result))
    return result
```

### 版本演进

```
① URL 版本（/api/v1/、/api/v2/）：最直观，前端切换成本明确
② Header 版本（Accept: application/vnd.x.v2+json）：URL 稳定
③ 字段兼容（只加不删）：小改动首选
```

**破坏性变更清单**（必须升版本）：

```
- 删字段 / 改字段名
- 改类型（string → int）
- 改语义（status 的枚举含义变了）
- 改必填性（原来可选变必填）
```

**非破坏性变更**（可直接上）：

```
- 加可选字段
- 加新的枚举值（前端要能容忍未知值）
- 加新接口
```

**前端要能容忍未知枚举**：

```js
const LABELS = { pending: "待支付", paid: "已支付" };
const label = LABELS[order.status] ?? order.status;   // 兜底显示原值
```

### 联调流程（避免三天）

```
① 契约先行（OpenAPI 定稿，双方评审）
② 前端用 mock 开发（不等后端）
③ 后端按契约实现，CI 里跑契约测试（schemathesis/dredd）
④ 联调用固定测试数据（准备一份种子数据脚本）
⑤ 有 request_id，出问题能立刻查日志
```

契约测试示例：

```bash
# 用 schemathesis 按 OpenAPI 自动生成请求并校验
schemathesis run https://api.example.com/openapi.json --checks all
```

### 检查清单

```
□ 有 OpenAPI 文档且在 Git 里
□ 字段命名、金额、时间、ID 类型有统一规范
□ 错误结构统一（code + message + request_id）
□ 分页有 page_size 上限
□ 创建接口支持幂等
□ 破坏性变更走版本，非破坏性变更前端能容忍
□ CI 有契约测试
□ 联调有种子数据与 mock
```
