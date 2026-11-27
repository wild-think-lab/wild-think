---
title: 前端性能：从"白屏 3 秒"到能测出原因的六个指标
description: 核心 Web 指标的含义与阈值、资源加载的关键路径、四个最常见的性能杀手、以及"本地很快线上很慢"的排查。
date: 2026-11-27
tags: [前端, 性能, Web Vitals, 优化]
---

### 六个指标

| 指标 | 含义 | 好 | 需改进 |
| --- | --- | --- | --- |
| TTFB | 首字节时间（服务端响应） | < 0.8s | < 1.8s |
| FCP | 首次内容绘制（看到东西） | < 1.8s | < 3s |
| LCP | 最大内容绘制（主要内容出现） | < 2.5s | < 4s |
| INP | 交互响应延迟（点击到响应） | < 200ms | < 500ms |
| CLS | 布局偏移（内容跳动） | < 0.1 | < 0.25 |
| TBT | 主线程阻塞总时长 | < 200ms | < 600ms |

用户感知的顺序：

```
TTFB（后端慢）→ FCP（资源慢）→ LCP（关键内容慢）→ INP（JS 重）→ CLS（样式/图片没占位）
```

**先定位是哪一段慢**，再谈优化。直接上"图片压缩"往往优化错地方。

### 怎么测

**① 实验室（可控）**

```bash
npx lighthouse https://example.com --preset=desktop --output=json
```

**② 真实用户（RUM）**

```js
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    report('LCP', e.startTime, { element: e.element?.tagName });
  }
}).observe({ type: 'largest-contentful-paint', buffered: true });
```

RUM 的价值：**实验室是"理想网络"，RUM 是真实用户的设备与网络**。两者常常差 2–3 倍。

**③ 分位而不是平均**

```
P50 好不代表用户感受好，要看 P75 与 P95。
Google 的评分也是按 P75 算的。
```

### 关键渲染路径

```
HTML 下载 → 解析 → 遇到 CSS（阻塞渲染）→ 遇到 JS（阻塞解析）
        → DOM + CSSOM → 布局 → 绘制 → 首次绘制（FCP）
```

三个"阻塞"点：

1. **同步 `<script>`**：阻塞 HTML 解析。
2. **`<link rel=stylesheet>`**：阻塞渲染（浏览器要等 CSS 才能画）。
3. **字体**：`font-display: swap` 可以让文字先用系统字体显示。

```html
<script src="app.js" defer></script>     <!-- 解析完再执行，不阻塞解析 -->
<script src="vendor.js" async></script>  <!-- 下载完立刻执行 -->
<link rel="preload" href="/hero.webp" as="image">
```

### 四个最常见的性能杀手

**① 首屏依赖大 JS bundle**

```
首次加载 2.5MB JS → 解析 + 执行 1.8s → 白屏
```

对策：

- 路由级代码分割（按页面拆 chunk）。
- 首屏不需要的组件懒加载。
- 第三方库按需引入（`lodash` 用 `lodash-es` + tree shaking）。

```js
const Chart = () => import('./Chart.vue');   // 首次渲染才加载
```

**② 图片未优化**

```html
<!-- 差 -->
<img src="/hero.png">

<!-- 好 -->
<img src="/hero.webp" width="1200" height="600"
     loading="lazy" fetchpriority="high"
     srcset="/hero-800.webp 800w, /hero-1200.webp 1200w">
```

四个属性的作用：

| 属性 | 作用 |
| --- | --- |
| `width/height` | 预留空间，防 CLS |
| `loading="lazy"` | 首屏外延后加载 |
| `fetchpriority="high"` | 首屏大图优先下载（LCP） |
| `srcset` | 按屏宽选择合适尺寸 |

**③ 主线程被长任务占满**

INP 差通常因为主线程在执行长任务（>50ms）。

```js
// 用 PerformanceObserver 找长任务
new PerformanceObserver((l) => {
  l.getEntries().forEach(e => console.log('longtask', e.duration, e.attribution));
}).observe({ entryTypes: ['longtask'] });
```

对策：

- 把大计算拆成分片（`requestIdleCallback` / `scheduler.yield`）。
- 重活放到 Web Worker。
- 减少首屏的同步计算（如大表格排序）。

**④ 服务端 TTFB 高**

TTFB 差说明问题在后端（或 CDN 未命中）。

```bash
curl -w "dns:%{time_namelookup} connect:%{time_connect} ttfb:%{time_starttransfer}\n" -o /dev/null -s https://example.com
```

`ttfb` 高但 `connect` 快 → 后端处理慢；`connect` 也慢 → 网络或 DNS。

### "本地很快，线上很慢"

五个常见原因：

1. **CDN 未命中**（缓存 key 配错，或资源带随机参数）。
2. **没有压缩**（Nginx 未开 gzip/brotli）。
3. **跨地域延迟**（服务器在异地，没有 CDN）。
4. **线上有额外的拦截层**（WAF、鉴权跳转）。
5. **线上是 HTTP/1.1**，并发连接受限（HTTP/2 多路复用能省很多）。

```bash
# 对比协议与压缩
curl -I https://example.com/app.js | grep -iE 'content-encoding|server|http'
```

### 优化优先级

按"投入产出比"排序：

```
① 开启 gzip/brotli + 静态资源长缓存（1 小时，收益大）
② 图片转 WebP/AVIF + 正确尺寸（半天）
③ 代码分割 + 懒加载（1–3 天）
④ 关键 CSS 内联、非关键 CSS 异步（1–2 天）
⑤ 拆长任务、上 Worker（按需）
⑥ 服务端渲染/预渲染（大工程，最后考虑）
```

大多数站点做完 ①②③ 就能把 LCP 从 4s 降到 2s 以内。

### 检查清单

```
□ 有 RUM 采集（P75 而不是平均）
□ LCP 元素明确（知道是哪张图/哪段文字）
□ 首屏 JS < 300KB（gzip 后）
□ 图片有宽高、有 srcset、有 lazy
□ 静态资源长缓存 + 内容哈希文件名
□ 开了 HTTP/2 与压缩
□ 有"线上 vs 本地"的对比数据
```
