---
title: TypeScript 工程化：类型不是装饰，是约束
description: tsconfig 的关键项、类型收窄与泛型的实用写法、以及五个"用了 TS 还是满屏 any"的原因。
date: 2026-11-27
tags: [前端, TypeScript, 工程化]
---

### 三个最该开的开关

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

**`strict` 是总开关**（含 noImplicitAny、strictNullChecks 等）。

**`noUncheckedIndexedAccess`** 让 `arr[0]` 的类型变成 `T | undefined`：

```
很烦，但能挡住"数组越界"这类真实 bug
```

**"只开 strict 不开严格索引"** 是折中方案，视项目而定。

### 类型收窄的四种方式

```ts
// ① typeof
function f(x: string | number) {
  if (typeof x === "string") return x.toUpperCase();
  return x.toFixed(2);
}

// ② 判别联合（最推荐）
type Result =
  | { ok: true; data: User }
  | { ok: false; error: string };

function handle(r: Result) {
  if (r.ok) return r.data.name;   // 这里有 data
  throw new Error(r.error);       // 这里有 error
}

// ③ in 操作符
type A = { a: string };
type B = { b: number };
function g(x: A | B) {
  if ("a" in x) return x.a;
}

// ④ 自定义类型守卫
function isUser(x: unknown): x is User {
  return typeof x === "object" && x !== null && "id" in x;
}
```

**"判别联合"是替代"一堆可选字段 + 到处判空"的最好方案**。

### 泛型的正确用法

```ts
// 好：约束关系清晰
function first<T>(xs: T[]): T | undefined {
  return xs[0];
}

// 好：用 keyof 约束键
function get<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

// 差：泛型没用上
function log<T>(x: T): void { console.log(x); }   // 直接用 unknown 即可
```

**"泛型只出现一次"基本都是多余的**。

### 常用工具类型

```ts
Partial<T>            // 全可选
Required<T>           // 全必填
Pick<T, K>            // 选字段
Omit<T, K>            // 排除字段
Record<K, V>          // 映射
Exclude<T, U>         // 联合排除
Extract<T, U>         // 联合筛选
ReturnType<F>         // 函数返回
Parameters<F>         // 函数参数元组
Awaited<P>            // 解 Promise
```

**"手写一堆 interface"之前，先想能不能用 `Pick/Omit` 派生**。

### 五个"用了 TS 还是满屏 any"的原因

**① 第三方库没类型**

```
没有 @types/xxx → 用 any 掩盖
正确：写一个最小 d.ts 声明（只声明你用到的部分）
```

**② 从接口返回值直接 any**

```ts
const data: any = await res.json();
// 正确：用 zod/valibot 校验并推导类型
const schema = z.object({ id: z.number(), name: z.string() });
const data = schema.parse(await res.json());   // 类型安全 + 运行时校验
```

**"外部数据必须校验"** —— 类型只在编译期有效，管不了运行时。

**③ `as` 到处断言**

```
as 是"我知道我比你清楚"，用多了等于放弃类型检查
```

**④ 只用类型，不做 Lint**

```json
{
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-floating-promises": "error"
  }
}
```

**`no-floating-promises`** 能抓到"忘了 await"（真实事故源）。

**⑤ 类型定义与后端不一致**

```
手写 interface，后端改了字段 → 运行时才炸
→ 用 OpenAPI 生成类型（openapi-typescript）
```

### 项目结构建议

```
src/
├── types/          # 全局类型（少量）
├── api/            # 请求 + 校验（zod）
├── features/
│   └── orders/
│       ├── model.ts      # 领域类型
│       ├── service.ts    # 数据访问
│       └── ui/
└── shared/
```

**"类型跟着领域走"**，别建一个巨型 `types.ts`。

### 检查清单

```
□ strict: true
□ 不开"全局 any"
□ 外部数据用 schema 校验（zod/valibot）
□ 用判别联合替代"可选字段 + 判空"
□ 泛型都有实际约束
□ 派生类型用 Pick/Omit/Record
□ Lint 禁 explicit any、禁 floating promises
□ 接口类型从 OpenAPI 生成
□ 不滥用 as
□ 类型定义按领域组织（非单一 types.ts）
```
