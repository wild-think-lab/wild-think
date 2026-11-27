---
title: 接口设计规范：让前后端不用每天吵架
description: URL 设计、状态码、错误体、鉴权、分页与幂等——一份能直接抄进团队文档的 REST 接口约定，附反例。
date: 2022-01-10
tags: [接口, REST, API, 后端, 工程规范]
---

### 一条总原则

接口是**契约**。契约不稳，前端就要不停改；契约不清晰，后端就要不停解释。

判断一份接口设计好不好，只看一件事：**新人拿到文档，能不能不提问就调通。**

### URL 与动词

```
GET    /api/v1/users            列表
GET    /api/v1/users/42         详情
POST   /api/v1/users            创建
PATCH  /api/v1/users/42         局部更新
DELETE /api/v1/users/42         删除
```

反例（很常见）：

```
GET /api/getUserList?type=1
POST /api/doUpdateUser
GET /api/user/delete?id=42     ← 用 GET 做写操作，会被爬虫/预取误触发
```

三条硬规则：

- **名词复数 + 资源层次**，不要动词。
- **版本号放路径**（`/api/v1/`），将来升级不必改老接口。
- **写操作只用 POST/PUT/PATCH/DELETE**。

### 状态码别乱用

| 码 | 含义 | 使用场景 |
| --- | --- | --- |
| 200 | 成功 | 查询、更新成功 |
| 201 | 已创建 | POST 创建资源 |
| 204 | 成功无内容 | DELETE |
| 400 | 参数错误 | 校验失败 |
| 401 | 未认证 | 没带 token / token 失效 |
| 403 | 无权限 | 登录了但没这个权限 |
| 404 | 不存在 | 资源不存在 |
| 409 | 冲突 | 唯一键重复、状态冲突 |
| 429 | 限流 | 触发频率限制 |
| 500 | 服务端错误 | 未捕获异常 |

反例：所有响应都返回 200，靠 `{code: -1}` 表示失败。这会让网关、监控、SDK 全部失效——它们只看 HTTP 状态码。

### 统一的错误体

```json
{
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "用户不存在",
    "traceId": "3f8a9c21",
    "details": [{ "field": "id", "issue": "not found" }]
  }
}
```

四条要求：

- `code` 是**稳定的机器码**，前端可按它做分支，不要用中文 message 判断。
- `message` 给人看，可以改措辞。
- `traceId` 用于串联日志，用户报障时让他提供这一个字段就够了。
- 不要返回堆栈、SQL、内部 IP——这是信息泄露。

### 分页与列表

```
GET /api/v1/orders?page=1&size=20&sort=-created_at&status=paid
```

```json
{
  "items": [...],
  "page": { "page": 1, "size": 20, "total": 137, "hasNext": true }
}
```

建议：

- 默认 `size=20`，上限 100（防止有人 `size=100000` 打库）。
- 大数据量用游标分页（`?cursor=xxx`），`offset` 越深越慢。
- 排序参数显式约定，别用 `orderby=1` 这种数字。

### 鉴权

最常用两种：

```
Authorization: Bearer <jwt>
```

或服务间用 HMAC 签名（含时间戳防重放）：

```
X-Sign: HMAC_SHA256(secret, method+path+body+timestamp)
X-Timestamp: 1700000000
```

要点：

- token 放 Header，**不要放 URL**（会进日志、进 Referer）。
- token 有效期短（15–60 分钟）+ refresh token。
- 服务间调用必须有时间窗（如 ±5 分钟），否则重放攻击随便打。

### 幂等：支付与重试的必修课

网络超时后客户端会重试，如果接口不幂等，就会出现"扣了两次钱"。

做法：客户端传幂等键，服务端落库去重。

```
POST /api/v1/payments
Idempotency-Key: 7f2c1b9e-...
```

```sql
-- 唯一索引兜底
ALTER TABLE payments ADD UNIQUE KEY uk_idem (idempotency_key);
```

服务端逻辑：先插幂等记录 → 冲突则返回上一次结果；成功后再执行业务。

### 版本与兼容

- 破坏性变更才升版本（删字段、改语义）。
- 加字段不算破坏性，前端必须容忍未知字段。
- 老版本保留至少 6 个月，并监控调用量，`0` 了再下线。

### 一份可直接抄的约定摘要

1. 路径 `/api/v{版本}/{资源复数}`，写操作不用 GET。
2. 成功 2xx，失败用对应 4xx/5xx，不搞"永远 200"。
3. 错误体固定 `{error:{code,message,traceId}}`。
4. 列表必须分页，`size` 有上限。
5. 认证走 Header，带过期时间。
6. 支付/创建类接口必须支持幂等键。
7. 所有接口有 OpenAPI/Swagger 文档，随代码提交。

把这些写进团队文档，比开十次会对齐有用——**规范的价值在于它不依赖任何人的记忆**。
