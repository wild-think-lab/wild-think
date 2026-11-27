---
title: CI 太慢怎么办：把 20 分钟压到 5 分钟的六个手段
description: 缓存、并行、增量、镜像预构建、runner 规格、失败快返，以及五个"加了缓存还是慢"的原因。
date: 2026-04-24
tags: [DevOps, CI, 效率]
---

### 先测"时间花在哪"

```
① 排队（等 runner）
② 拉代码
③ 装依赖（npm/pip/maven）
④ 编译
⑤ 测试
⑥ 构建镜像 + 推送
```

**"20 分钟里 12 分钟在装依赖"** → 优化目标非常明确。

### 手段一：依赖缓存

```yaml
# GitHub Actions
- uses: actions/cache@v4
  with:
    path: ~/.npm
    key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}
    restore-keys: ${{ runner.os }}-npm-

# GitLab CI
cache:
  key:
    files: [package-lock.json]
  paths: [node_modules/]
```

**"key 用 lock 文件 hash"** 才能"依赖变了才重装"。

### 手段二：并行

```yaml
jobs:
  lint: ...
  test:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
```

**把测试分片**：

```
1000 个测试 → 4 个分片各 250 → 时间降到 1/4
```

**"单 job 跑全部测试"** 是最容易优化的点。

### 手段三：只跑"变更相关"

```
① 路径过滤（改了 docs 不跑单测）
② 增量构建（只编译变动模块）
③ 只跑受影响的测试（依赖图分析）
```

```yaml
on:
  push:
    paths-ignore: ['docs/**', '*.md']
```

**"任何提交都跑全量"** 是最浪费的做法。

### 手段四：镜像预构建

```
① 基础镜像预装依赖（node_modules 不进每次构建）
② 多阶段构建 + 层缓存
③ 镜像仓库缓存（buildx cache-to/from）
```

```dockerfile
COPY package*.json ./
RUN npm ci --only=production   # 这层能命中缓存
COPY . .
```

**"先 COPY 全部再 npm ci"** 会让缓存永远失效（最常见的 Dockerfile 错误）。

### 手段五：runner 规格与就近

```
① CPU/内存不够 → 编译慢
② runner 在远端机房 → 拉代码/推镜像慢
③ 自建 runner + 本地缓存（最快）
```

**"托管 runner 每次全新环境"** → 缓存收益有限，自建 runner 更划算。

### 手段六：失败快返

```
① lint 放最前（几秒失败）
② 单测按"最可能失败"在前
③ 编译失败立即停（fail-fast）
```

**"跑 15 分钟才在最后一步报 lint 错"** 是体验最差的情况。

### 五个"加了缓存还是慢"

**① 缓存没命中**

```
key 里带了 run_id / 时间戳 → 永远新 key
```

**② 缓存太大**

```
把 node_modules 整个缓存（几百 MB）→ 上传/下载比安装还慢
→ 缓存"包管理器缓存目录"（~/.npm）而不是 node_modules
```

**③ 缓存被并发覆盖**

```
多个 job 同时写同一 key → 冲突/损坏
```

**④ 瓶颈不在依赖**

```
装依赖很快，但编译 10 分钟（大项目）→ 要并行/增量
```

**⑤ 排队时间被忽略**

```
总时长 20 分钟，其中 10 分钟在排队等 runner
→ 加 runner 并发数，不是优化 job
```

**"总时长 = 排队 + 执行"**，很多人只看执行。

### 一个"优化顺序"

```
1) 看清"排队 vs 执行"的比例
2) 依赖缓存（最高性价比）
3) 并行分片 + 路径过滤
4) Dockerfile 层缓存
5) runner 规格/就近/自建
6) 失败快返（体验）
```

### 检查清单

```
□ 有"各阶段耗时"的可视化
□ 依赖缓存（key 用 lock hash）
□ 缓存"包管理目录"而非整个 node_modules
□ 测试分片并行
□ 路径过滤（docs 不触发全量）
□ Dockerfile 层顺序正确（依赖在前）
□ 镜像构建用 cache-to/from
□ runner 规格足够
□ 自建 runner（高频项目）
□ lint/编译失败快返
□ 关注"排队时间"
```
