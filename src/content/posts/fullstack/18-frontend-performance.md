---
title: 前端性能：先量化，再优化
description: 六个核心指标、从"打包"到"运行时"的优化顺序，以及五个"优化了但没变快"的原因。
date: 2026-11-27
tags: [前端, 性能]
---

### 六个指标（先量化）

```
① LCP（最大内容绘制）：主要内容何时可见 —— 目标是 < 2.5s
② INP（交互到下一次绘制）：点击响应 —— 目标 < 200ms
③ CLS（布局偏移）：视觉稳定性 —— 目标 < 0.1
④ TTFB：服务端响应 —— 目标 < 800ms
⑤ FCP：首次内容绘制
⑥ TBT：长任务阻塞时间（INP 的前置指标）
```

**"感觉慢了"不算问题，"LCP 4.2s"才算**。

### 优化的顺序（性价比从高到低）

```
① 减少传输体积（图片/JS/字体）
② 减少请求数（合并/内联关键资源）
③ 减少主线程工作（代码分割/延迟执行）
④ 减少网络往返（CDN/HTTP2/预连接）
⑤ 服务端（缓存/SSR）
```

**"先做 ①②"** 通常能拿到 60% 的收益。

### ① 图片（最常见的体积黑洞）

```html
<img src="a.avif" srcset="a-480.avif 480w, a-960.avif 960w" sizes="(max-width:600px) 480px, 960px"
     loading="lazy" width="960" height="540" alt="">
```

**要点**：

```
① AVIF/WebP（比 JPEG 小 30–60%）
② srcset 按屏幕宽度给不同尺寸
③ 首屏图不要 lazy（会推迟 LCP）
④ 写死 width/height（避免 CLS）
```

**"一张 2MB 的 PNG 当 banner"** 是最常见的问题。

### ② JS 体积

```
① 代码分割（路由级 + 组件级）
② 按需引入（组件库要 tree-shaking）
③ 去掉 polyfill（按目标浏览器）
```

```js
// 路由级懒加载
const Detail = () => import('./Detail.vue');
```

**"打包成一个 1.5MB 的 bundle"** 是首屏慢的主因。

**检查**：

```bash
npx vite-bundle-visualizer
# 或 webpack-bundle-analyzer
```

**"可视化"才知道哪个包最大**。

### ③ 主线程

```
① 长任务拆分（用 requestIdleCallback / 分片）
② 大数据列表虚拟滚动
③ 少用"同步布局"（读 layout 再写样式 → 强制重排）
```

**INP 差通常来自"一次点击触发大量同步计算"**。

### ④ 网络

```
① CDN（静态资源）
② 预连接（dns-prefetch / preconnect）
③ 关键 CSS 内联
④ 字体子集化 + font-display: swap
```

**"字体加载阻塞渲染"** 很常见（一个中文字体 3MB）。

### 五个"优化了但没变快"

**① 优化了非瓶颈**

```
花两天压缩 JS（省 50KB），但瓶颈是 2MB 的图片
```

**用 Lighthouse/Performance 面板先找瓶颈**。

**② 本地快、线上慢**

```
本地无网络延迟、无 CDN 命中问题
→ 用"线上真实用户数据"（RUM）看
```

**③ 缓存没配好**

```
JS 文件名不带 hash → 每次都要重新下载
→ 内容哈希 + 长缓存
```

```nginx
location ~* \.(js|css)$ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}
```

**④ 首屏数据串行**

```
页面加载 → 请求配置 → 再请求列表 → 再请求详情
→ 三次串行往返（每次 100ms+）
```

**"能并行的就别串行"**。

**⑤ 第三方脚本**

```
埋点/客服/广告脚本 → 阻塞主线程
→ 延迟加载 / 放 iframe / 用 partytown
```

**"第三方脚本"经常是 LCP 的最大敌人**。

### 一个"上线前"的检查

```
□ Lighthouse 移动端 ≥ 80（关键页面）
□ LCP < 2.5s（4G 模拟）
□ 首屏 JS < 200KB（gzip）
□ 图片全部 WebP/AVIF + 正确尺寸
□ 静态资源长缓存 + hash
□ 字体子集化 + swap
□ 无第三方阻塞脚本
```

### 检查清单

```
□ 用 RUM 量化（不只 Lighthouse）
□ 先找瓶颈再优化
□ 图片格式/尺寸/懒加载
□ JS 分割与按需
□ 静态资源 hash + 长缓存
□ 关键 CSS 内联
□ 字体子集化
□ 首屏请求并行
□ 第三方脚本延迟
□ 有性能预算（bundle 大小上限）
```
