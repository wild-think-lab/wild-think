---
title: 容器镜像瘦身：从 1.2GB 到 90MB 的六个动作
description: 多阶段构建、基础镜像选择、层合并、.dockerignore、清理缓存、以及"为什么小了却更慢了"。
date: 2025-03-08
tags: [Docker, 镜像, 优化]
---

### 先看一个典型的大镜像

```bash
docker images
# app    latest   1.2GB

docker history app:latest
# 逐层看谁在占空间
```

**常见元凶**：

```
① 用了 node:20（含完整构建工具链）而不是 node:20-alpine
② COPY . . 把 .git/ node_modules/ 都带进去
③ 构建产物与源码都在同一镜像
④ apt/yum 缓存没清
⑤ 多阶段构建没用
```

### 动作一：多阶段构建（收益最大）

```dockerfile
# 构建阶段
FROM golang:1.21 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/app ./cmd/app

# 运行阶段
FROM gcr.io/distroless/static-debian12
COPY --from=build /out/app /app
ENTRYPOINT ["/app"]
```

**结果**：1.2GB → 20MB（Go 静态二进制）。

**Node 的例子**：

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

**`npm ci` 放在 COPY . . 之前**：依赖不变时能命中缓存（否则每次都要重装）。

### 动作二：选对基础镜像

| 基础镜像 | 大小 | 适用 |
| --- | --- | --- |
| alpine | ~5MB | 大多数场景（注意 musl libc 兼容） |
| distroless | ~20MB | 静态二进制、无 shell、最安全 |
| debian slim | ~75MB | 需要 glibc 的复杂依赖 |
| 完整 debian | ~120MB+ | 构建阶段用 |

**alpine 的坑**：

```
用的是 musl libc，不是 glibc
→ 某些预编译二进制（如某些 Java/Node 原生模块）不兼容
→ 需要自己编译或换 debian slim
```

**distroless 的坑**：

```
没有 shell，不能 docker exec 进去排查
→ 需配合 "ephemeral container" 或 sidecar 调试
```

### 动作三：合并层 + 清理缓存

```dockerfile
# 差（两个层，缓存留下）
RUN apt-get update
RUN apt-get install -y curl

# 好（一层，装完就清）
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
```

**关键点**：

```
① 用一条 RUN 完成"更新+安装+清理"（否则清理无效，因为前一层已固化了缓存）
② --no-install-recommends 少装推荐包
③ alpine 用 apk add --no-cache
```

### 动作四：.dockerignore

```
.git
.gitignore
node_modules
dist
*.log
.env*
tmp/
.vscode
.idea
test/
docs/
```

**没有 .dockerignore 的后果**：`COPY . .` 会把 `.git`（可能几百 MB）带进镜像，并且破坏缓存（每次改代码都触发重装依赖）。

### 动作五：去掉不必要的工具

```
只在构建阶段需要的：编译器、git、curl、make
运行阶段不需要 → 不装

例：Java 应用运行只需要 JRE，不需要 JDK
```

### 动作六：压缩与检查

```bash
# 看每层大小
docker history --format "{{.Size}}\t{{.CreatedBy}}" app:latest | head -20

# 看最终镜像里有什么
docker run --rm -it app:latest sh    # 如果镜像有 shell
# 或用工具
dive app:latest
```

**`dive` 是最好的分析工具**：它按层展示"哪些文件被添加/删除"，能精确找出浪费。

### "镜像小了却更慢了"的四个原因

**① 用了 alpine，触发了兼容问题**

```
某些库在 musl 下走慢路径，或需要重新编译
```

**② 冷启动变慢**

```
镜像小 → 拉取快
但 distroless/alpine 少了 page cache 预热，首次请求可能慢
```

**③ 少了编译优化的二进制**

```
GO 的 -ldflags="-s -w" 去掉调试信息（小 30%），但 panic 栈更难读
```

**④ 层顺序破坏了缓存**

```
把 COPY . . 放在 npm ci 之前 → 每次改代码都重装依赖 → 构建慢 5 分钟
```

**优化镜像不只是"小"，还要"构建快、运行稳"**。

### 一份完整示例（Node + Nginx）

```dockerfile
# ---- build
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime
FROM nginx:1.25-alpine
RUN rm -rf /usr/share/nginx/html/*
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
```

**加 `HEALTHCHECK` 是个便宜的好习惯**（非 K8s 环境尤其有用）。

### 安全相关（顺带瘦身）

```
① 用非 root 用户运行
   USER 1000:1000
② 固定基础镜像版本（不要 latest）
   FROM nginx:1.25.3-alpine
③ 用 digest 更严格
   FROM nginx@sha256:xxxxx
④ 扫描漏洞
   trivy image app:latest
```

**"小"和"安全"往往是同一个方向**：少装东西=少漏洞面。

### 检查清单

```
□ 多阶段构建（构建与运行分离）
□ 基础镜像用 alpine/distroless/slim
□ 依赖安装放在 COPY . . 之前（缓存）
□ 一条 RUN 完成 装+清
□ 有 .dockerignore
□ 运行阶段不装构建工具
□ 用 dive 或 history 检查过层
□ 非 root 运行
□ 固定版本（不用 latest）
□ trivy 扫过
```
