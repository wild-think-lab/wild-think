---
title: API 契约：OpenAPI 不是文档，是"承诺"
description: 契约先行的三个收益、spec 的六个必写部分、以及五个"文档和实现两张皮"的原因。
date: 2026-09-04
tags: [后端, API, OpenAPI]
---

### 契约先行的三个收益

```
① 前后端并行（不用等接口写完）
② 自动生成类型/客户端（少一半联调）
③ 变更可审查（diff 就是影响面）
```

**"先写 spec 再写代码"** 比"写完代码补文档"省时间，不是多花时间。

### spec 的六个必写部分

```yaml
openapi: 3.0.3
info:
  title: Orders API
  version: 1.0.0
servers:
- url: https://api.example.com/v1
paths:
  /orders/{id}:
    get:
      summary: 查询订单
      parameters:
      - name: id
        in: path
        required: true
        schema: {type: string, format: uuid}
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: {$ref: '#/components/schemas/Order'}
        '404':
          description: Not found
          content:
            application/json:
              schema: {$ref: '#/components/schemas/Error'}
components:
  schemas:
    Order:
      type: object
      required: [id, status, amount]
      properties:
        id: {type: string, format: uuid}
        status: {type: string, enum: [created, paid, shipped, cancelled]}
        amount: {type: integer, description: 金额（分）}
    Error:
      type: object
      required: [code, message]
      properties:
        code: {type: string}
        message: {type: string}
```

**六个必写**：

```
① 版本与 servers
② 每个响应码（含错误）
③ 枚举值（不用魔法数字/字符串）
④ 单位与格式（金额用分、时间用 RFC3339）
⑤ 必填字段
⑥ 错误结构统一
```

### 三个"必写但最常漏"的细节

**① 错误响应**

```
只写 200 → 前端不知道 404/409/422 长什么样
```

**② 单位**

```
amount: integer（分）  vs  amount: number（元）
→ 不写清楚，必然有一方算错
```

**③ 分页参数**

```
page/size  vs  cursor
→ 深分页时 page 方案会崩
```

**统一分页结构**：

```yaml
    Page:
      type: object
      properties:
        items: {type: array, items: {$ref: '#/components/schemas/Order'}}
        next_cursor: {type: string, nullable: true}
```

### 从 spec 生成代码

```bash
# TypeScript 类型
npx openapi-typescript spec.yaml -o src/api/types.ts

# 客户端
npx openapi-generator-cli generate -i spec.yaml -g typescript-fetch -o src/api

# 服务端骨架（Go）
oapi-codegen -package api spec.yaml > api.gen.go
```

**"生成类型"** 让前端不用手抄 interface（也不会写错字段）。

### 五个"文档和实现两张皮"的原因

**① 手写文档，不用 spec**

```
代码改了文档没改 → 三周后完全不可信
```

**② spec 不在 CI 里校验**

```
实现与 spec 不一致，没人发现
→ 用契约测试（Dredd/Schemathesis）或"从 spec 生成服务端骨架"
```

**③ 只在"发布时"更新**

```
应该在"改接口的同一个 PR 里"更新
```

**④ 错误码各自定义**

```
A 接口返回 {code, msg}，B 接口返回 {error: {code}}
→ 客户端要写两套解析
```

**⑤ 没版本化**

```
直接改字段语义 → 老客户端崩
→ URL 版本 /api/v1 或 header 版本
```

### 契约测试怎么做

```bash
# 用 schemathesis 对运行中的服务做属性测试
schemathesis run https://api.example.com/openapi.json \
  --checks all --hypothesis-max-examples=50
```

**"自动生成边界输入"** 能发现很多"文档没写但实现会崩"的情况。

### 一个"最小可行"的落地方式

```
1) 新接口：先写 spec（PR 里一起）
2) CI：spec lint（spectral）+ 生成类型
3) 前端：从 spec 生成类型
4) 变更：spec diff 审查（改了哪些字段/枚举）
5) 老接口：分批补 spec（按调用量排序）
```

**"从新接口开始"** 比"要求全量补文档"现实。

### 检查清单

```
□ 接口有 spec（先写后写都要有）
□ 每个响应码都定义
□ 枚举明确（不靠约定）
□ 单位与时间格式统一
□ 错误结构统一
□ 分页方案明确（深分页用 cursor）
□ spec 在 CI 里 lint
□ 从 spec 生成类型/客户端
□ spec 变更走 review（看 diff）
□ 有版本化策略
□ 有契约测试
```
