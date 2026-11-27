---
title: 微前端：什么时候真的需要拆
description: 三种主流方案（iframe/Web Component/模块联邦）、隔离的三个维度、五个"拆完更难维护"的原因。
date: 2025-07-28
tags: [前端, 架构, 微前端]
---

### 先问一句：真的需要吗

```
微前端解决的是"多个团队在同一页面上各自发布"的问题
如果只有一个团队/一个版本节奏 → 不需要
```

**"为了技术先进而拆"** 是典型的负收益。

### 三种主流方案

**① iframe（最彻底）**

```
隔离最彻底（JS/CSS/事件全隔开）
代价：通信麻烦、弹窗/滚动/高度同步、SEO 差
```

**② Web Component / 自定义元素**

```
用 customElements.define 注册一个标签
宿主页面 <app-header></app-header>
隔离：CSS 需 Shadow DOM；JS 仍共享 window
```

**③ 模块联邦（Module Federation，webpack 5 / rspack）**

```
子应用暴露模块，宿主运行时加载
隔离：最弱（共享运行时）→ 需要严格约定
```

**"模块联邦"** 最灵活，也最容易出问题（版本/依赖）。

### 隔离的三个维度

```
① 样式：Shadow DOM / CSS 前缀 / scoped
② JS：全局变量、事件监听、定时器
③ 依赖：React/Vue 版本是否共享
```

**"样式隔离做了，JS 冲突还在"** → 一个子应用的 `window.xxx` 覆盖了别人的。

### 模块联邦的最小例子

```js
// 子应用 webpack.config.js
new ModuleFederationPlugin({
  name: "header",
  filename: "remoteEntry.js",
  exposes: { "./Header": "./src/Header.jsx" },
  shared: { react: { singleton: true }, "react-dom": { singleton: true } },
});

// 宿主
new ModuleFederationPlugin({
  remotes: { header: "header@https://cdn.example.com/remoteEntry.js" },
});
```

**`singleton: true`** 是关键：避免 React 被加载两份（hooks 会失效）。

### 通信约定

```
① props（简单，但跨框架难）
② 自定义事件（CustomEvent）
③ 全局事件总线（最松，最难治理）
④ postMessage（iframe 专用）
```

**"直接读对方 store"** 是最坏的做法（深度耦合）。

### 五个"拆完更难维护"

**① 版本不一致**

```
宿主用 React 17、子应用用 18 → hooks 崩
```

**② 样式污染**

```
全局 CSS 变量互相覆盖
```

**③ 构建产物重复**

```
每个子应用都打一份 React + 组件库 → 首屏变大
```

**④ 路由冲突**

```
各自管 history → 前进后退错乱
```

**⑤ 发布不受控**

```
子应用随时发版 → 宿主突然白屏（无灰度）
```

**解决"⑤"**：子应用的版本要"可锁定 + 可灰度"（remoteEntry 地址带版本）。

### 什么时候选哪个

```
团队完全独立、页面区域清晰（如支付/客服）→ iframe
同一个技术栈、需要共享组件 → 模块联邦
跨框架、区域独立 → Web Component + Shadow DOM
```

**"跨框架"** 几乎是唯一"必须用 iframe/WebComponent"的理由。

### 落地清单

```
□ 明确的边界（谁拥有哪块区域）
□ 依赖策略（shared / singleton / 独立打包）
□ 样式隔离方案（Shadow DOM / prefix）
□ 通信协议（事件 + 类型定义）
□ 版本与灰度（remoteEntry 带版本 + 回退）
□ 监控（子应用加载失败率）
□ 降级（加载失败时显示 fallback）
```

### 检查清单

```
□ 先论证"是否真的需要"
□ 选型与团队/技术栈匹配
□ 样式与 JS 隔离都有方案
□ 共享依赖有明确策略
□ 通信只用约定接口（不读对方内部）
□ 子应用版本可锁定/可回退
□ 有加载失败监控与 fallback
□ 有统一的路由约定
□ 构建产物不重复（去重共享库）
□ 有"迁移/退出"预案
```
