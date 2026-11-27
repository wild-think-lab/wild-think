---
title: 镜像工程化：怎么做出"小、快、可追溯"的镜像
module: 入门篇
summary: 多阶段构建、基础镜像选择、分层缓存、非 root 与健康检查，以及镜像瘦身的五个实际手段。
minutes: 20
---

### 一个好镜像的四条标准

```
① 小（拉取快、攻击面小）
② 快（构建快、启动快）
③ 可追溯（能对应到 commit）
④ 安全（非 root、无多余工具、有扫描）
```

### 多阶段构建（最有效的一招）

```dockerfile
# 构建阶段
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app ./cmd/app

# 运行阶段
FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/app /app
USER nonroot:nonroot
ENTRYPOINT ["/app"]
```

**效果**：

```
单阶段：900MB（含 Go 工具链）
多阶段：20MB 左右
```

**"构建依赖不进运行镜像"是瘦身的根本**。

### 基础镜像怎么选

| 基础镜像 | 大小 | 适合 |
| --- | --- | --- |
| `distroless` | 极小 | Go/Rust 静态二进制（推荐） |
| `alpine` | ~5MB | 需要 shell 调试（musl 兼容问题要注意） |
| `debian:slim` | ~30MB | 通用（glibc 兼容好） |
| `ubuntu` | ~70MB | 需要完整工具链 |
| 官方语言镜像 | 大 | 构建阶段用 |
| `scratch` | 0 | 完全静态二进制（无 shell、无调试能力） |

**`alpine` 的坑**：

```
musl libc 与 glibc 行为不同（DNS 解析、locale、某些二进制）
→ 需要 glibc 的二进制在 alpine 上跑不起来
```

**"我们在 alpine 上跑得好好的，为什么 xx 不行"** 基本都是这个原因。

### 分层缓存（构建快的核心）

```dockerfile
# 好的顺序：变化少的在前
COPY go.mod go.sum ./
RUN go mod download          # 依赖层（很少变）
COPY . .                     # 代码层（经常变）
RUN go build -o /out/app .
```

**规则**：

```
每个指令一层
某层变化 → 它及之后的所有层都要重建
→ 把"变化频率低的"放前面
```

**`COPY . .` 之前一定要先 COPY 依赖文件**，否则每次改代码都要重装依赖。

### .dockerignore（必须有）

```
node_modules
.git
dist
*.log
.env
tests
docs
```

**不写 `.dockerignore` 的后果**：

```
context 太大 → 构建慢
.git 进镜像 → 镜像变大 + 泄露历史
```

### 非 root + 只读文件系统

```dockerfile
RUN addgroup -S app && adduser -S app -G app
USER app

# 运行时可加 --read-only（需要可写目录时挂 tmpfs）
```

```yaml
# K8s 里
securityContext:
  runAsNonRoot: true
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
```

**"容器里是 root"是常见的安全短板**：

```
容器逃逸后直接是宿主 root（如果没做用户命名空间隔离）
```

### 健康检查

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/app", "-healthcheck"]
```

**注意**：

```
① `start-period` 给启动留时间（否则刚起就被判定失败）
② 健康检查不要依赖外部（否则外部故障导致容器被杀）
```

**"健康检查里查数据库"是危险设计**：

```
数据库抖动 → 全部容器被判不健康 → 集体重启 → 雪崩
```

### 五个瘦身手段

```
① 多阶段构建（构建依赖不进运行镜像）
② 用 distroless/alpine 代替大基础镜像
③ 清理包管理器缓存（rm -rf /var/lib/apt/lists/*）
④ 合并 RUN 指令（减少层数，也便于清理）
⑤ 剥离二进制符号（Go: -ldflags="-s -w"）
```

**"先合并 RUN 再清理"**：

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
```

**分成两个 RUN 是没用的**（清理在同一层才行）。

### 可追溯

```
① 镜像 tag 用 commit sha（不用 latest）
② 打 OCI 标签（source / revision / created）
③ 构建产物带 SBOM（软件物料清单）
```

```bash
docker build \
  --label org.opencontainers.image.source=https://github.com/org/repo \
  --label org.opencontainers.image.revision=$(git rev-parse HEAD) \
  -t registry/app:$(git rev-parse --short HEAD) .
```

**"latest" 是最危险的 tag**：

```
同一个 latest 在不同时间对应不同镜像
→ 无法复现、无法回滚到"上次那个"
```

### 安全检查

```bash
# 扫描漏洞
trivy image registry/app:v1

# 检查 Dockerfile 最佳实践
hadolint Dockerfile
```

**"扫描进 CI"** 是低成本高收益的一步：

```
镜像构建后立刻扫 → 高危漏洞就拦下来
```

### 一个"标准 Dockerfile"模板

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
RUN addgroup -S app && adduser -S app -G app
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
```

### 检查清单

```
□ 多阶段构建
□ 基础镜像选小（distroless/alpine/slim）
□ 依赖层与代码层分开（缓存有效）
□ 有 .dockerignore
□ 非 root 运行
□ 有 healthcheck 且 start-period 合理
□ 健康检查不依赖外部
□ 清理包缓存（同一 RUN 内）
□ tag 用 commit sha（不用 latest）
□ 打 OCI 标签（source/revision）
□ CI 里有 trivy + hadolint
```
