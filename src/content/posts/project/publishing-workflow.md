---
title: 项目：本站的发布流程与内容工作流
description: 从写好一篇 Markdown 到线上可访问，中间有几步是必须的：schema 校验、base 前缀、索引重建、发布验证。这份记录可当作模板复用。
date: 2025-12-29
tags: [项目, GitHub Pages, 发布流程, 工作流, Astro]
---

站点上线不是 `git push` 就完事。静态站没有后端兜底，**构建期就是唯一的质检环节**。下面是这个站的固定流程。

## 一、写作阶段

文章只放在一个位置：`src/content/posts/<专题>/<slug>.md`。目录名决定归属专题。

Frontmatter 必填项：

```yaml
---
title: 标题（不超过 30 字，会出现在列表与 SEO 标题）
description: 一句话摘要（列表页与搜索结果都用它）
date: 2025-12-29
tags: [Linux, 排障, 日志]
featured: false       # 可选
draft: false          # 可选，true 不参与构建
---
```

三条约定：

1. `description` 写"读者能得到什么"，不是复述标题。
2. `tags` 用**名词**而不是句子（`慢查询` 而不是 `怎么排查慢查询`），否则标签页会散成几百个。
3. 文件名为英文短横线格式，保证 URL 稳定、可分享。

## 二、本地校验

```bash
npm run dev      # 实时预览，检查排版与目录
npm run build    # 构建期校验 frontmatter schema
```

构建失败通常就三类：

| 报错 | 原因 |
| --- | --- |
| `ZodError: date` | 日期写成非法格式 |
| `Missing parameter` | 路由参数里含 `/`（如标签 `TCP/IP` 需要剩余参数路由） |
| `Expected "(" but found "type"` | `.ts` 文件里误加了 `.astro` 的 `---` 分隔 |

## 三、base 前缀：项目页部署的必修课

站点地址是 `https://wild-think-lab.github.io/wild-think/`，因此 `base` 必须配置，且**所有内链都要经过包装**：

```ts
// src/lib/url.ts
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export function u(path = '/') {
  const clean = '/' + String(path).replace(/^\/+/, '');
  if (clean === '/') return BASE + '/';
  return BASE + clean.replace(/\/$/, '') + '/';
}
```

判断是否漏掉：构建后打开 `dist/index.html`，搜索 `href="/`，出现不以 `/wild-think` 开头的内链就是漏了。

## 四、发布阶段

```bash
git add -A
git commit -m "post: 新增 xxx 笔记"
git push origin main
```

GitHub Actions 触发构建，产物上传到 Pages。工作流要点：

- `permissions: pages: write, id-token: write`（缺了会 403）
- `actions/upload-pages-artifact` + `actions/deploy-pages`（官方推荐，替代旧的 gh-pages 分支方案）
- `cache: npm` 加速，但 `npm ci` 必须配合 `package-lock.json`

## 五、上线后的验证清单

```bash
# 1) 首页可访问且返回 200
curl -o /dev/null -s -w '%{http_code}\n' https://wild-think-lab.github.io/wild-think/

# 2) 新文章页可访问
curl -o /dev/null -s -w '%{http_code}\n' <新文章 URL>

# 3) 索引与订阅源同步更新
curl -s <站点>/search-index.json | head -c 200
curl -s <站点>/rss.xml | head -20
```

浏览器侧再人工确认三件：

- 列表页顺序正确（新文章在最前）；
- 文章内目录（TOC）跳转准确；
- 深浅色切换后没有对比度过低的区域。

## 六、常见"发布成功但页面错"

1. **页面 404**：base 未配对，或 `trailingSlash` 与链接形式不一致。
2. **样式丢失**：CSS 用了绝对路径 `/styles/...`，未加 base。
3. **中文标签页 404**：URL 未做逐段编码（`encodeURIComponent`）。
4. **旧内容没更新**：Pages 有 CDN 缓存，等 1–2 分钟；或浏览器强制刷新。
5. **Actions 卡在 deploy**：检查 Pages 设置里的 Source 是否为 "GitHub Actions"。

## 七、内容维护节奏

| 频率 | 动作 |
| --- | --- |
| 有想法就写 | 存草稿，`draft: true` 不影响构建 |
| 每周 | 发布 1–2 篇，检查标签是否重复、是否该合并 |
| 每月 | 更新旧文（加 `updated` 字段），清理失效命令与版本号 |
| 每季 | 检查外链、构建时长、页面数量，决定是否需要引入更强搜索 |

> 一句话：**静态站的"质量"完全由构建期校验和发布后验证决定。把这两步固化成流程，比写更多文章更重要。**
