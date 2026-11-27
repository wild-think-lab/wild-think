---
title: GitHub Actions 实战：一条能用的 CI 流水线
description: 从零写一份工作流：缓存依赖、跑测试、构建镜像、推仓库，以及私有仓与自托管的取舍。
date: 2026-11-21
tags: [DevOps, CI, GitHub Actions, 流水线, 部署]
---

### CI 的最小定义

每次提交后自动做三件事：**装依赖 → 跑测试 → 产出制品**。人工点一次不算 CI，自动触发才算。

### 一份完整的工作流

`.github/workflows/ci.yml`：

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: 安装依赖
        run: npm ci

      - name: 类型检查
        run: npm run typecheck

      - name: 单元测试
        run: npm test -- --coverage

      - name: 构建
        run: npm run build

      - name: 上传制品
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
          retention-days: 7
```

要点：

- `npm ci` 而不是 `npm install`：严格按 lock 文件装，构建可复现。
- 每一步一个 `name`，失败时一眼看出卡在哪。
- 制品上传保留 7 天，方便回滚与排查。

### 构建并推送镜像

```yaml
  image:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:${{ github.sha }}
```

**同时打 `latest` 和 `sha` 两个 tag**，回滚时用 sha 精确定位，比 latest 可靠。

### 密钥与权限

```yaml
env:
  API_URL: ${{ vars.API_URL }}          # 非敏感配置
  TOKEN: ${{ secrets.DEPLOY_TOKEN }}    # 敏感值
```

三条铁律：

1. 密钥只放 Secrets，**不要写进 yml**。
2. `permissions` 显式声明最小权限，默认的写权限太大。
3. Fork 来的 PR 默认拿不到 Secrets——这是保护，别想办法绕过。

### 缓存：把 3 分钟建到 40 秒

```yaml
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cache/pip
            ~/.npm
          key: ${{ runner.os }}-deps-${{ hashFiles('**/lock*') }}
```

`key` 里带 lock 文件的哈希：依赖变了缓存自动失效，没变就命中。

### 私有仓与自托管 runner

私有仓 Actions 有分钟数限额；如果构建需要访问内网资源（数据库、内部镜像仓库），用自托管 runner：

```bash
# 在自有机器上
./config.sh --url https://github.com/组织/仓库 --token <一次性token>
sudo ./svc.sh install && sudo ./svc.sh start
```

```yaml
runs-on: [self-hosted, linux, build]
```

代价是：这台机器要自己维护、自己打补丁、自己保证干净——**自托管 runner 等于多了一台生产服务器**。

### 部署这一步要不要放进 Actions

| 做法 | 优点 | 风险 |
| --- | --- | --- |
| Actions 直接 ssh 部署 | 简单 | 密钥权限大，日志暴露风险 |
| Actions 只构建镜像，部署由 CD 工具做 | 职责清晰 | 多一套系统 |
| Actions 触发 webhook，由部署系统拉取 | 安全 | 需要内网可达的接口 |

小项目最实际：**构建镜像 + 触发部署 webhook**，把"能改生产"的权限留在内网。

### 本章要点

- CI = 每次提交自动装依赖、跑测试、出制品。
- 用 `npm ci`、显式 `permissions`、双 tag（latest + sha）。
- 密钥只放 Secrets，缓存 key 带 lock 哈希。
- 自托管 runner 是生产力也是运维负担，别轻易上。
