---
title: API 设计规范：让前后端不用每天对接口
description: 命名与资源建模、错误码体系、分页与过滤、幂等与版本、以及"接口设计不好"带来的五个连锁成本。
date: 2026-11-27
tags: [全栈, API, 设计规范, 后端]
---

### 一份规范能省掉什么

接口设计不好，会产生五种长期成本：

1. 前端每天问"这个字段是啥意思"。
2. 同样的查询在不同接口里返回不同结构。
3. 错误处理只能靠字符串匹配。
4. 加字段就破坏兼容。
5. 出问题无法从日志定位是哪次调用。

### 资源建模

```
GET    /v1/orders                 列表
POST   /v1/orders                 创建
GET    /v1/orders/{id}            详情
PATCH  /v1/orders/{id}            局部更新
DELETE /v1/orders/{id}            删除
GET    /v1/orders/{id}/items      子资源
```

规则：

- **名词复数 + 层级**，不要动词（`/getOrder` 是坏味道）。
- 需要动作时用子资源或显式动词：`POST /v1/orders/{id}/cancel`。
- **版本放路径前缀**（`/v1/`），不要放 header（难排查）。

### 统一响应结构

```json
{
  "data": { "id": "o-1001", "status": "paid" },
  "meta": { "requestId": "2f8a", "ts": "2026-11-27T10:00:00Z" }
}
```

错误：

```json
{
  "error": {
    "code": "ORDER_NOT_FOUND",
    "message": "订单不存在或已删除",
    "details": { "orderId": "o-1001" },
    "requestId": "2f8a"
  }
}
```

三条要求：

1. **`code` 是机器可读的稳定标识**，前端按它做分支，不要匹配 `message`（文案随时会改）。
2. **`requestId` 必须返回**，用户报错时能据此查日志。
3. **HTTP 状态码要正确使用**：400 参数错、401 未认证、403 无权限、404 不存在、409 冲突、422 语义错误、429 限流、500 服务端错误。

### 错误码体系

```
格式：<域>_<对象>_<原因>

ORDER_NOT_FOUND          订单不存在
ORDER_STATUS_CONFLICT    状态不允许该操作
PAY_AMOUNT_MISMATCH      金额不匹配
AUTH_TOKEN_EXPIRED       token 过期
RATE_LIMIT_EXCEEDED      触发限流
```

设计要点：

- **码表集中管理**（一个文件/一张表），不要散落在各 handler 里。
- **码值稳定**，改动只允许"新增"，不允许"改含义"。
- **HTTP 状态码 + 业务 code 两者都要**：状态码给网关/监控用，code 给业务用。

```yaml
# 码表示例
ORDER_NOT_FOUND:      { http: 404, msg: "订单不存在" }
ORDER_STATUS_CONFLICT:{ http: 409, msg: "订单状态不允许此操作" }
```

### 分页

**三种方式，按场景选**：

```json
// ① offset 分页（后台管理，数据量小）
GET /v1/orders?page=2&size=20
{ "data": [...], "meta": { "total": 1200, "page": 2, "size": 20 } }

// ② cursor 分页（列表流、大数据量）
GET /v1/orders?cursor=eyJpZCI6MTAwfQ&limit=20
{ "data": [...], "meta": { "nextCursor": "eyJpZCI6ODB9" } }

// ③ 时间范围（日志/事件类）
GET /v1/events?since=2026-11-27T00:00:00Z&until=...
```

坑：

- offset 分页在数据变化时会**跳条或重复**（第 2 页可能包含第 1 页出现过的记录）。
- `total` 在大表上代价很高（要 count 全表）。大数据量场景直接不返回 total。

### 幂等

创建类接口必须支持幂等：

```http
POST /v1/orders
Idempotency-Key: 7f3a-...
```

服务端行为：

```
① 收到请求，检查 key 是否已处理
② 已处理 → 返回上次的结果（不重复创建）
③ 未处理 → 处理并记录结果（key → 结果，TTL 24h）
```

没有幂等键的系统，用户"网络超时后点重试"就会产生两笔订单。

### 版本与兼容

**向后兼容的字段变更**（可随时做）：

- 新增可选字段。
- 新增枚举值（前提：客户端有 default 分支）。
- 新增接口。

**破坏性变更**（必须走新版本）：

- 删除字段、改字段含义、改类型。
- 收紧校验（原来可选的变必填）。
- 改 URL 结构。

```json
// 标记弃用而不破坏
{ "data": { "userName": "a", "user_name": "@deprecated use userName" } }
```

### 五个常见设计错误

1. **列表返回不统一**：有的 `{items: []}`，有的 `{list: []}`。
2. **用 200 表示错误**：`{code: 500, msg: "失败"}` 但 HTTP 是 200，监控完全看不到错误率。
3. **时间格式混乱**：有的 `2026-11-27`，有的 `1750000000`，有的带时区有的不带。统一 ISO8601 + UTC。
4. **枚举用中文**：`status: "已支付"`，改文案就破坏兼容。
5. **没有分页上限**：客户端传 `size=100000`，直接把数据库打死。

```python
size = min(max(int(request.args.get("size", 20)), 1), 100)   # 强制上限
```

### 契约与文档

- 用 **OpenAPI** 描述，接口定义与代码同仓，CI 里校验。
- 前后端共享同一份 schema，不靠口头约定。
- 生成的 mock 能让前端不等后端。

```yaml
paths:
  /v1/orders:
    get:
      parameters:
      - { name: cursor, in: query, schema: { type: string } }
      - { name: limit,  in: query, schema: { type: integer, maximum: 100, default: 20 } }
```

### 检查清单

```
□ 资源命名是名词复数，动作用子资源
□ 错误码是稳定的机器可读标识 + 正确 HTTP 状态码
□ 响应统一含 requestId
□ 分页有上限，大数据量用 cursor
□ 创建接口支持幂等键
□ 时间是 ISO8601 + UTC
□ 破坏性变更走新版本
□ 有 OpenAPI 契约，CI 校验
```
