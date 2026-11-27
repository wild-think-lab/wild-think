---
title: CI 为什么越跑越慢：构建加速的六个入手点
description: 先定位"哪一步慢"，再从缓存、并行、镜像、依赖、测试分层、机器规格六个方向优化，附实测对比。
date: 2026-11-27
tags: [CI/CD, 构建, 性能, DevOps]
---

### 先定位，不要猜

```bash
# GitHub Actions：看每一步耗时
gh run view <run-id> --log | grep -E 'Run |completed in'

# GitLab CI：看 job 的 duration
# Jenkins：Blue Ocean 里看 stage 时间
```

典型分布（一个中等项目，总 12 分钟）：

| 阶段 | 耗时 |
| --- | --- |
| 拉代码 | 20s |
| 装依赖 | 3m |
| 编译 | 4m |
| 单元测试 | 2m |
| 构建镜像 | 2m |
| 推送 + 部署 | 1m |

**装依赖 + 编译占了 60%**，优化这两块收益最大。

### ① 依赖缓存（收益最大，成本最低）

**GitHub Actions**：

```yaml
- uses: actions/cache@v4
  with:
    path: |
      ~/.cache/go-build
      ~/go/pkg/mod
    key: go-${{ hashFiles('go.sum') }}
    restore-keys: go-
```

**GitLab CI**：

```yaml
cache:
  key:
    files: [go.sum]
  paths:
    - .cache/go-build
    - vendor/
```

**关键**：缓存 key 用**锁文件的 hash**，锁文件变了才失效。

效果（实测）：

```
无缓存：装依赖 3 分 10 秒
有缓存：装依赖 25 秒
```

### ② 并行

**拆分 job**（lint / test / build 并行）：

```yaml
jobs:
  lint:  { ... }
  test:  { ... }     # 与 lint 无依赖，并行跑
  build: { needs: [lint, test] }
```

**测试分片**（pytest 4 片）：

```bash
pytest --splits 4 --group 1
pytest --splits 4 --group 2
```

**注意边际收益**：4 片并行后，总时间 ≈ 最慢那片 + 启动开销。8 片往往不比 4 片快（启动与调度成本上升）。

### ③ 构建镜像：多阶段 + 缓存挂载

```dockerfile
# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -o /out/app ./cmd/app

FROM alpine:3.20
COPY --from=build /out/app /app
ENTRYPOINT ["/app"]
```

`--mount=type=cache` 让**层缓存失效时依赖缓存仍然有效**（比 `COPY go.mod` 分层更省）。

BuildKit 需要开启：

```yaml
- name: Set up Buildx
  uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v6
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

效果：镜像构建 2 分钟 → 40 秒。

### ④ 依赖来源

```
① 用内网/就近的镜像源（npm/pip/maven 都换国内源或私有仓）
② 锁定版本（避免 CI 每次解析最新兼容版本）
③ 少装（devDependencies 只在需要的阶段装）
```

```bash
npm ci --prefer-offline --no-audit        # 比 npm install 快且确定
pip install -r requirements.txt --no-cache-dir=false
```

`npm ci` 比 `npm install` 快 20–40%，且不会改 lock 文件。

### ⑤ 测试分层

```
PR 阶段：只跑"受影响的测试" + 快速冒烟（< 3 分钟）
合并后：全量单元测试
每日：集成测试 + E2E
```

**"每次 PR 都跑全量 E2E"是 CI 变慢的头号原因**。E2E 应该在自己的流水线里，且只在合并到主干后跑。

按变更范围选择测试（monorepo 常用）：

```yaml
- run: |
    changed=$(git diff --name-only origin/main...HEAD | grep '^services/api/' || true)
    [ -z "$changed" ] || make test-api
```

### ⑥ 机器规格与 runner

```
① 自建 runner（比云上共享 runner 稳定，且能配大机器）
② 缓存目录放本地 SSD（不要每次从对象存储拉）
③ 足够的并发 runner（排队是隐性耗时）
```

对比（同一项目）：

| 配置 | 总耗时 |
| --- | --- |
| 2 核共享 runner | 12 分钟 |
| 4 核共享 runner | 7 分钟 |
| 8 核自建 + 本地缓存 | 3 分 20 秒 |

**"排队时间"要单独统计**：如果平均排队 5 分钟，加 runner 比优化构建更有效。

### 优化后的完整对比

```
优化前：12 分 10 秒
① 依赖缓存        -2m45s
② 并行 lint/test  -1m20s
③ 镜像缓存挂载     -1m20s
④ npm ci + 就近源  -40s
⑤ 测试分层        -1m30s
⑥ runner 4→8 核   -1m15s
优化后：3 分 20 秒
```

### 检查清单

```
□ 先测各阶段耗时（不猜）
□ 依赖有缓存（key 用锁文件 hash）
□ lint/test 并行
□ 镜像用 BuildKit cache mount
□ 依赖用就近源 + 锁定版本
□ PR 只跑受影响的测试
□ E2E 不在 PR 阶段跑
□ 统计"排队时间"（可能需要加 runner）
□ 缓存目录在本地 SSD
```
