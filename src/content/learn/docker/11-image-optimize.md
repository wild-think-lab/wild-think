---
title: 镜像瘦身与多架构构建
module: 进阶篇
summary: 多阶段构建、基础镜像选择、层缓存技巧、buildx 多架构，五个"镜像 2GB 但只跑 20MB 代码"的原因。
minutes: 45
---

### 先看镜像里有什么

```bash
docker image ls
docker history --no-trunc app:latest | head -20
docker run --rm -it app:latest du -sh /usr /opt
```

**判据**：镜像大小 ≈ 基础镜像 + 依赖 + 代码 + 构建工具残留。

### 多阶段构建（最有效）

```dockerfile
# 构建阶段
FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app ./cmd/app

# 运行阶段（不带工具链）
FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/app /app
USER nonroot:nonroot
ENTRYPOINT ["/app"]
```

**效果**：从 900MB（带编译器）到 10-20MB。

### 基础镜像怎么选

```
① distroless：最小、无 shell（安全，但难调试）
② alpine：小，但 musl libc 可能有兼容问题
③ slim（Debian）：折中，兼容性好
④ 官方 runtime（node:20-slim / python:3.12-slim）
```

**"alpine 跑 glibc 二进制"** → 报 "not found" 或 DNS 异常。

### 层缓存技巧

```dockerfile
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
```

```
先拷依赖清单 → 装依赖 → 再拷源码
（源码改动不会让依赖层失效）
```

**"COPY . . 在最前面"** → 每改一行代码都重装依赖。

### 五个"镜像巨大"

**① 构建工具留在运行镜像**

```
gcc/maven/npm 全在最终镜像里
```

**② 缓存目录被拷进去**

```
node_modules、.git、~/.cache
```

```dockerfile
# 用 .dockerignore
.git
node_modules
*.log
```

**③ 单条 RUN 里 apt 没清理**

```dockerfile
RUN apt-get update && apt-get install -y curl \
 && rm -rf /var/lib/apt/lists/*
```

**④ 用了 full 版基础镜像**

```
python:3.12 (1GB) vs python:3.12-slim
```

**⑤ 多层重复安装**

```
每个阶段都 apt install 一遍
```

### 多架构（buildx）

```bash
docker buildx create --use --name multi
docker buildx build --platform linux/amd64,linux/arm64 \
  -t registry.example.com/app:1.0 --push .
```

**注意**：

```
① 基础镜像要支持目标架构
② 模拟构建慢（可用交叉编译）
③ 清单（manifest）合并后，docker pull 自动选架构
```

```bash
docker manifest inspect registry.example.com/app:1.0
```

### 安全相关

```dockerfile
USER 10001:10001
# 只读根文件系统（运行时）
docker run --read-only --tmpfs /tmp app
```

**"用 root 跑容器"** → 容器逃逸风险放大。

### 检查清单

```
□ 多阶段构建（运行镜像不含工具链）
□ 基础镜像选 distroless/slim
□ 有 .dockerignore
□ 依赖层与源码层分开（缓存友好）
□ apt 安装后清理缓存
□ 非 root 用户运行
□ 镜像扫描（无高危）
□ 打具体 tag（不用 latest）
□ 多架构按需 buildx
□ 镜像大小有基线（防回涨）
```
