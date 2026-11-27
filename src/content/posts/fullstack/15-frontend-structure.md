---
title: 前端项目结构：一个能撑住三年迭代的目录长什么样
description: 按"功能"还是"类型"分、shared/core/features 的边界、状态放哪、以及五个半年后必后悔的做法。
date: 2026-11-27
tags: [前端, 架构, React, 工程化]
---

### 两种分法，选哪个

```
按类型：components/  hooks/  utils/  services/
按功能：features/user/  features/order/
```

**成熟项目的答案通常是"混合"**：

```
顶层按功能（features）
每个功能内部按类型（components/hooks/api）
跨功能共享的放 shared
```

**原因**：

```
按类型分 → 三个月后 components/ 里 200 个文件，不知道哪些属于同一业务
按功能分 → 删掉一个功能只需删一个目录
```

### 推荐的目录骨架

```
src/
├── app/                     # 应用装配（入口、路由、全局 provider）
│   ├── App.tsx
│   ├── router.tsx
│   └── providers.tsx
├── shared/                  # 跨功能共享（无业务语义）
│   ├── ui/                  # 通用组件（Button/Modal/Table）
│   ├── lib/                 # 工具（http/date/storage）
│   ├── hooks/               # 通用 hooks
│   └── types/               # 全局类型
├── features/                # 业务功能
│   └── user/
│       ├── components/      # 只属于 user 的组件
│       ├── api/             # user 的接口封装
│       ├── hooks/           # user 的 hooks
│       ├── store/           # user 的状态（按需）
│       └── index.ts         # 对外只导出必要内容
├── pages/                   # 路由页面（薄，只装配）
└── assets/
```

**"pages 要薄"是关键**：

```
页面只做"取数据 + 组合 feature 组件"
业务逻辑在 features 里
→ 换路由框架时只改 pages
```

### shared 与 features 的边界

**判断标准**：

```
shared：与业务无关（换成任何项目都能用）
features：含业务语义（提到"订单""用户"就是 feature）
```

**反例**：

```
shared/ui/OrderStatusBadge.tsx   ← 名字里带 Order，应该进 features
shared/lib/formatOrderAmount.ts  ← 同上
```

**为什么重要**：

```
shared 一旦混入业务，就变成"第二个 utils 垃圾场"
所有人都往里塞，最后没人敢动
```

### 状态放哪（三个层次）

```
① 组件内状态：useState（只影响该组件）
② 跨组件（同一功能）：功能的 store / context
③ 跨功能（全局）：app 级 store（尽量少）
```

**"全局 store 越大越难维护"**：

```
好的做法：每个 feature 自带 store，只在 app 层组合
坏的做法：一个巨大的 globalStore，所有人都往里加
```

**服务端数据不要放全局 store**：

```
用 TanStack Query / SWR 管理"远程数据"
（缓存、失效、重试它都能做）
全局 store 只放"客户端状态"（如 UI 模式、登录用户）
```

**这条能省掉大量手写的 loading/error 逻辑**。

### 五个半年后必后悔的做法

**① 一个 `utils/index.ts` 塞了 200 个函数**

```
后果：互相依赖、循环引用、无法按需加载
```

**改法**：按领域拆（`utils/date.ts`、`utils/http.ts`），或直接放进 shared/lib。

**② 组件层层嵌套的 props**

```tsx
<A x={x} y={y} z={z} onA={...} onB={...} />
  → <B x y z onA onB />
    → <C x y z onA onB />
```

**改法**：

```
① 组合（children / slots）代替层层传参
② Context（同一子树共享，但不要滥用）
③ 把"数据获取"上移到页面层
```

**③ 把接口调用散在各组件里**

```tsx
// 到处都是
const res = await fetch('/api/user/1')
```

**改法**：

```
所有接口集中在 features/xxx/api/
组件只调用 hooks（useUser(id)）
→ 便于统一错误处理、mock、改协议
```

**④ 没有"领域类型"**

```
所有接口都返回 any，或者到处定义重复的 interface
```

**改法**：`features/user/types.ts`，或从 OpenAPI 生成。

**⑤ 循环依赖**

```
features/user 引用了 features/order
features/order 又引用了 features/user
```

**改法**：

```
① 提取共同部分到 shared（真正的公共能力）
② 或引入"事件/消息"解耦（不直接引用）
③ 用 ESLint 的 import/no-cycle 检测
```

### 一份 ESLint 边界规则

```json
{
  "rules": {
    "no-restricted-imports": ["error", {
      "patterns": [
        { "group": ["**/features/*/components/*"], "message": "跨 feature 不要直接引组件，走 index.ts 导出" },
        { "group": ["../../**"], "message": "不要跨多层相对路径" }
      ]
    }]
  }
}
```

**更彻底的是用 `eslint-plugin-boundaries`**（按目录声明允许的依赖方向）。

**规则示例**：

```
shared 不能 import features
features 不能互相 import（或只允许 index.ts）
pages 可以 import features 与 shared
```

**这是"架构不会腐化"的唯一自动化手段**。

### 路径别名

```json
// tsconfig.json
{
  "compilerOptions": {
    "baseUrl": "src",
    "paths": {
      "@/*": ["*"],
      "@shared/*": ["shared/*"],
      "@features/*": ["features/*"]
    }
  }
}
```

**价值**：

```
① 不再写 ../../../../
② 移动文件时不用改引用
③ 一眼看出"这是跨模块依赖"
```

### 一个真实的"三年后"对比

**坏的**：

```
src/
├── components/     (312 个文件，平铺)
├── utils/          (index.ts 800 行)
├── pages/          (每个页面里塞满业务逻辑)
└── api/            (86 个散落的 fetch)
```

**症状**：改一处要读 30 个文件，删功能不敢删。

**好的**：

```
src/
├── shared/ui       (45 个通用组件，有 Storybook)
├── shared/lib      (12 个领域拆分文件)
├── features/       (18 个功能，各自独立)
├── pages/          (薄装配层)
└── app/            (路由 + provider)
```

**症状**：删一个功能 = 删一个目录 + 删一个路由。

### 检查清单

```
□ 顶层按 feature 分，feature 内按类型分
□ shared 只放无业务语义的东西
□ pages 只做装配（业务在 features）
□ 每个 feature 有 index.ts 收口
□ 远程数据用 Query 库（不放全局 store）
□ 全局 store 尽量小
□ 接口调用集中在 api/
□ 有领域类型定义（或从 schema 生成）
□ 路径别名（@/）
□ ESLint 边界规则 + no-cycle
□ 有 Storybook（至少 shared/ui）
```
