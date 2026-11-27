# 野生思考 · wild-think

> 把复杂的技术，变成可以落地复现的思考与实践

一个面向底层技术实践者的静态知识库，覆盖 Linux、网络、安全、云原生与 SRE、数据库、全栈、面试、实验、工具箱、项目十个专题。

- 站点地址：https://wild-think-lab.github.io/wild-think/
- 技术栈：Astro 5（静态构建）+ 手写 CSS 设计系统，零第三方运行时依赖
- 特性：深浅色切换、站内全文搜索、文章目录、阅读进度、标签与归档、RSS、Sitemap

## 本地开发

```bash
npm install
npm run dev        # http://localhost:4321/wild-think/
npm run build      # 产物输出到 dist/
npm run preview    # 预览构建产物
```

## 写一篇新文章

1. 在 `src/content/posts/<专题>/` 下新建 `<slug>.md`
2. 填写 frontmatter：
   ```yaml
   ---
   title: 标题
   description: 一句话摘要（列表页、搜索、SEO 都会用）
   date: 2026-11-27
   tags: [Linux, 排障]
   ---
   ```
3. 目录名决定归属专题（`linux` / `network` / `security` / `sre-cloud` / `db` /
   `fullstack` / `interview` / `lab` / `tools` / `project`）
4. `npm run dev` 预览，`npm run build` 校验 schema

可选字段：`updated`、`featured`、`draft`（true 不参与构建）、`minutes`（阅读时间）。

## 目录结构

```
src/
├── components/      # Icon（内联 SVG）
├── layouts/         # BaseLayout：导航、页脚、主题切换
├── lib/             # site.ts（专题定义）、posts.ts（查询）、url.ts（base 前缀）
├── pages/           # 首页 / 专题 / 文章 / 标签 / 归档 / 搜索 / 关于 / RSS / Sitemap
├── content/posts/   # 全部 Markdown 文章，按专题分目录
├── content.config.ts
└── styles/global.css  # 设计系统（CSS 变量 + 组件样式）
```

## 部署

当前线上通过 **gh-pages 分支** 发布（GitHub Pages 的 source 设为 `gh-pages` 分支）：

```bash
npm run build
# 将 dist/ 内容提交到 gh-pages 分支（保持 .nojekyll）
```

想要"推 main 自动发布"，可在本机执行一次授权，让 GitHub CLI 拿到 workflow 权限，然后把
`docs/deploy-actions.example.yml` 复制为 `.github/workflows/deploy.yml` 并提交：

```bash
gh auth refresh -s workflow,repo,read:org
```

随后在仓库 Settings → Pages 把 Source 改为 **GitHub Actions**，删除 gh-pages 分支即可。
OAuth App 令牌没有 `workflow` 权限时，GitHub 会拒绝推送任何 `.github/workflows/` 下的文件。

> 说明：站点挂在项目页 `/wild-think/` 子路径下，所有内链必须经过 `src/lib/url.ts` 的 `u()` 包装，否则会 404。
>
> 标签路由只保留 `src/pages/tags/[...tag].astro`（标签可能含 `/`，如 `TCP/IP`）。
> 同目录的 `[tag].astro` 已停用（`getStaticPaths` 返回空），可以直接删除。

## 设计约定

- 默认深色，手动切换后写入 `localStorage`
- 单一强调色（暖橙）+ 中性灰阶，不使用第三方 UI 框架
- 图标全部内联 SVG，不引 CDN、不增加请求
- 不做第三方统计、不引评论服务
