---
title: 这个博客是怎么搭的：Astro 静态站点的取舍清单
description: 从主题选型、内容模型、路由设计到搜索引擎与部署，说明一个纯静态技术博客的完整技术决策，以及为什么放弃 Tailwind 与第三方统计。
date: 2025-12-04
tags: [Astro, 静态站点, 前端, 构建, GitHub Pages]
---

这个站点的每一处设计都是可以解释的。把决策摊开讲，比展示最终效果更有用。

## 一、为什么是 Astro

候选方案与淘汰理由：

| 方案 | 优点 | 为什么不选 |
| --- | --- | --- |
| Hexo | 生态成熟、模板多 | 构建慢、组件化弱、主题定制要改模板语法 |
| VitePress | 文档体验好、搜索内置 | 偏"文档站"，首页与专题页的自由布局受限 |
| Next.js | 能力强 | 需要 Node 运行时，GitHub Pages 只能静态导出，收益不大 |
| **Astro** | 默认零 JS、Markdown 原生、组件自由、静态输出 | 需要自己写内容模型（但可控） |

关键点：Astro 的 `.astro` 组件就是"HTML + 前端脚本"，首页可以完全手工排版，而不是被主题的槽位限制。

## 二、不用 Tailwind，自己写 CSS

这不是为了炫技，是因为这个站点的设计系统很小且稳定：

```css
:root {
  --bg: #08080a;
  --text: #e9e9ef;
  --accent: #ff8a3d;
  --line: rgba(255, 255, 255, 0.08);
}
html.light { --bg: #fbfaf8; --text: #17171c; }
```

一套 CSS 变量 + 一遍 `html.light` 覆盖，就完成了完整的深浅色切换，产物是一个小的 CSS 文件，没有构建期扫描、没有原子类膨胀。对**自有站点**这是更高性价比的选择；团队协作场景才需要 Tailwind 的一致性约束。

## 三、内容模型：目录即专题

文章放在 `src/content/posts/<专题>/<文件名>.md`，目录名直接决定归属专题。用 Astro 的 Content Layer 声明 schema：

```ts
const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string().default(''),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    topic: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});
```

好处：**Frontmatter 写错会在构建期报错**，而不是上线后页面空白。`z.coerce.date()` 让 `2026-11-24` 这种 YAML 日期自动转成 Date 对象，排序不用手动处理字符串。

## 四、路由设计

| 路径 | 用途 |
| --- | --- |
| `/` | 首页：Hero + 专题卡片 + 最近更新 |
| `/topics/`、`/topics/<id>/` | 专题索引与单专题 |
| `/writing/`、`/writing/<slug>/` | 全部文章与文章详情 |
| `/tags/`、`/tags/<tag>/` | 标签索引与聚合 |
| `/archive/` | 按年份归档 |
| `/search/` | 站内全文搜索 |
| `/search-index.json`、`/rss.xml` | 构建期生成的索引与订阅源 |

标签用**剩余参数路由** `[...tag].astro`，因为标签里可能有斜杠（如 `TCP/IP`），普通 `[tag]` 参数会被当成两个路径段导致构建失败。

## 五、搜索：在浏览器里做，不依赖任何服务

构建时生成一个 JSON 索引（标题、描述、标签、正文前 400 字），页面加载后在前端做子串匹配与高亮。

```ts
export const GET: APIRoute = async () => {
  const posts = await allPosts();
  return new Response(JSON.stringify(posts.map((p) => ({
    title: p.data.title,
    url: u(postHref(p)),
    tags: p.data.tags,
    text: plainExcerpt(p.body ?? '', 420),
  }))), { headers: { 'Content-Type': 'application/json' } });
};
```

取舍：全文检索能力弱于 Pagefind（后者会做分词与索引分片），但**没有额外依赖、构建更快、搜索词不出浏览器**。文章上百篇后再换 Pagefind 也是平滑的。

## 六、部署：推上去就发布

```yaml
name: Deploy to GitHub Pages
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
```

注意 `base` 配置：项目页部署在 `/wild-think/` 子路径下，所有内链必须带上 base，否则 404。这一点靠一个 `u()` 函数统一处理：

```ts
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export function u(path = '/') { /* 统一补前缀 */ }
```

## 七、放弃的东西，以及原因

- **第三方统计**：不需要知道谁在访问，也不想页面加载别人的脚本。
- **评论系统**：静态站接评论要引第三方服务，会带入外链与隐私问题。需要讨论时再引入。
- **暗色/亮色跟随系统**：默认深色，手动切换后写入 `localStorage`，避免"白天打开还是黑的"这种半吊子跟随。
- **图标库**：所有图标是手写的 SVG path，一个文件几十行，不引 CDN、不增加请求。

## 八、可复用的经验

1. 先定**信息架构**，再定视觉。专题怎么切、文章怎么归类，比配色重要一个数量级。
2. 内容 schema 要严格，让错误在构建期暴露。
3. 路径前缀（base）从一开始就用函数封装，别事后补。
4. 想要长期维护的静态站，依赖越少越好——半年后回来改，你只需要记得 Astro 的语法。

> 这个站的源码在 `wild-think-lab/wild-think`，构建日志、页面数量、部署流程都可以自己复现一遍。
