---
title: 前端工程化：从一行 index.html 到能上线的构建
description: 为什么前端需要构建工具、Vite 与 Webpack 的分工、依赖管理与产物分析，以及一个前后端分离项目的最小工程结构。
date: 2021-10-08
tags: [前端, 工程化, Vite, 构建, 部署]
---

### 为什么不能直接扔一个 HTML 上去

早期网站就是 `index.html + style.css + app.js`，FTP 上传就完事。现在不行，原因很具体：

1. **模块化**：代码分成几十个文件，浏览器原生 ESM 加载 200 个请求太慢。
2. **语法降级**：TypeScript、JSX、新语法浏览器不认，需要编译。
3. **体积**：依赖包几百 MB，需要打包、摇树、压缩、分包。
4. **资源**：图片、字体、CSS 需要哈希命名 + 缓存策略。
5. **环境**：开发要热更新，生产要压缩与 sourcemap。

构建工具就是替你把上面五件事自动化。

### Vite 与 Webpack 的分工差异

| 维度 | Vite | Webpack |
| --- | --- | --- |
| 开发启动 | 原生 ESM，秒级 | 先打包，几十秒起（大项目更久） |
| 生产构建 | Rollup | Webpack |
| 生态 | 新，插件少一些 | 极成熟，什么都能配 |
| 配置复杂度 | 低 | 高 |
| 适合 | 新项目、中小型 | 老项目、深度定制 |

结论：**新项目直接 Vite**。老项目迁移成本高，不必为迁而迁。

### 最小工程结构

```
web/
├── index.html          # 唯一入口，Vite 从这里解析
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── api/http.ts
│   └── styles/base.css
├── public/             # 原样拷贝，不参与构建
├── vite.config.ts
└── package.json
```

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/app/',                     // 部署在子路径时必须设
  build: {
    outDir: 'dist',
    sourcemap: false,                // 生产一般关掉，或用 hidden
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'axios'],  // 把不变的依赖单独分包，命中缓存
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://10.10.10.31:8080', changeOrigin: true },
    },
  },
})
```

`base` 那行是最容易被忘的：部署到 `/app/` 却没设，页面白屏，控制台一堆 404。

### 依赖管理与 lock 文件

```bash
npm ci            # CI 用这个，严格按 lock 安装，快且可复现
npm install       # 本地加依赖用
npm outdated      # 看哪些过时
npm audit         # 查已知漏洞
```

原则：

- `package-lock.json` **必须提交**。
- 生产依赖与开发依赖分清（`-D` 装构建工具）。
- 不要 `npm update` 一把梭，尤其大版本升级要单独验证。
- 依赖越多，供应链风险越大——一个被投毒的小包能偷走你的环境变量。

### 产物分析与优化

```bash
npm run build
npx vite-bundle-visualizer     # 看哪个包最大
```

常见优化顺序（按收益排）：

1. **分包**：把 vendor 拆出去，业务改动不影响缓存。
2. **按需加载**：路由级 `import()`，首屏只加载当前页。
3. **图片压缩与格式**：webp/avif 能省 50%+。
4. **去掉没用的依赖**：一个 `moment` 换成 `dayjs` 能省 200KB。
5. **压缩与 tree-shaking**：确保构建用生产模式。

### 部署与后端对接

```nginx
server {
  listen 80;
  server_name app.example.com;
  root /var/www/app/dist;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;   # 前端路由必须加这行
  }

  location /api/ {
    proxy_pass http://10.10.10.31:8080/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location ~* \.(js|css|png|woff2)$ {
    expires 30d;
    add_header Cache-Control "public, immutable";
  }
}
```

两个高频事故：

- **`try_files` 没加** → 刷新二级路由 404。
- **静态资源没设缓存** → 每次访问都重新下载，首屏慢 2 秒。

### 一个真实的排查案例

"用户反馈白屏，本地正常"。排查顺序：

1. 打开 DevTools Network，看 `main.js` 是否 404 → `base` 配错。
2. 看 Console 是否有 `Cannot read property of undefined` → 依赖版本或环境变量缺失。
3. 看是否只有某个地区白屏 → CDN 缓存了旧版 `index.html`，与新的哈希资源不匹配。解法：`index.html` 不缓存（`Cache-Control: no-cache`），静态资源才长缓存。

前端工程化的价值不在"用了什么工具"，而在**把"能不能上线"变成一件确定的事**：构建通过、产物可分析、缓存策略明确、回滚只需换一个目录。
