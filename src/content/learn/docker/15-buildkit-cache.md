---
title: 构建加速：BuildKit 与缓存实战
module: 进阶篇
summary: BuildKit 的并行与缓存挂载、跨机器缓存、构建时间的度量与定位，五个"构建慢 10 分钟"的原因。
minutes: 45
---

### 先量一下

```bash
DOCKER_BUILDKIT=1 docker build --progress=plain -t app:1.0 . 2>&1 | ts
```

**判据**：输出里每步耗时都打印 → 找出最慢的两步，别整体瞎优化。

### 缓存挂载（BuildKit）

```dockerfile
# syntax=docker/dockerfile:1.7
RUN --mount=type=cache,target=/root/.npm npm ci
RUN --mount=type=cache,target=/go/pkg/mod go mod download
```

**效果**：依赖缓存跨构建保留，不写进镜像层。

**关键**：`target` 必须与工具的真实缓存目录一致。

### 依赖层缓存

```dockerfile
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -o /out/app ./cmd/app
```

```
清单先拷 → 依赖单独层 → 源码后拷
源码改动不会让依赖层失效
```

### 跨机器缓存

```bash
docker buildx create --name ci --driver docker-container \
  --use --driver-opt network=host
# registry 作为缓存后端
docker buildx build \
  --cache-from type=registry,ref=registry.example.com/app:cache \
  --cache-to type=registry,ref=registry.example.com/app:cache,mode=max \
  -t registry.example.com/app:1.0 --push .
```

**`mode=max`** 缓存所有中间层（更省时间，占空间多）。

### 五个"构建慢 10 分钟"

**① COPY . . 在前**

```
改一行代码 → 依赖重装
```

**② 没有 cache mount**

```
每次从零下载依赖
```

**③ 单阶段构建**

```
编译工具链反复安装
```

**④ 构建上下文太大**

```
把 node_modules/.git 传给 daemon（能到几个 GB）
```

```bash
# .dockerignore
.git
node_modules
dist
*.log
```

**⑤ CI 不复用缓存**

```
每次干净机器 → mode=max + registry 缓存
```

### 并行与平台

```bash
# 多架构并行（会很吃内存）
docker buildx build --platform linux/amd64,linux/arm64 ...
```

**注意**：QEMU 模拟 arm 构建可能慢 5-10 倍，能交叉编译就交叉编译。

### 五个"缓存不生效"

```
① 清单文件被一起拷进 COPY . .（顺序问题）
② 缓存 target 路径错
③ 用了 --no-cache（调试后忘了删）
④ 基础镜像 tag 变动导致层失效
⑤ 构建上下文每次变化（生成文件被拷入）
```

### 检查清单

```
□ 有 --progress=plain 的耗时基线
□ 清单先拷、源码后拷
□ 依赖用 cache mount
□ 有 registry 缓存（mode=max）
□ .dockerignore 完整
□ 多阶段构建
□ 基础镜像用固定 digest
□ 多架构按需（避免 QEMU 拖慢）
□ 构建时间有监控（回归即报警）
□ CI 与本地用同一构建方式
```
