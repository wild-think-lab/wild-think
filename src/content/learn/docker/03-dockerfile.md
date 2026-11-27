---
title: Dockerfile：把应用打成镜像
module: 熟练篇
summary: 一个能上生产的 Dockerfile 长什么样：基础镜像怎么选、层怎么排、多阶段构建怎么砍体积、哪些写法必须避免。
minutes: 13
---

### 一个跑得起来的例子

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```bash
docker build -t registry.example.com/api:1.0.0 .
docker run -d -p 8000:8000 registry.example.com/api:1.0.0
```

能跑，但还不算好。下面逐条优化。

### 层顺序：为什么先 COPY 依赖再 COPY 代码

Docker 按层缓存。`COPY . .` 会把所有源码放进一层，**只要改一行代码，后面所有层都失效**，依赖得重装。

正确顺序：**变化少的在前**。

```
FROM → WORKDIR → COPY 依赖清单 → RUN 装依赖 → COPY 源码 → CMD
```

这样改代码只重建最后一层，构建从 2 分钟降到 10 秒。

### 多阶段构建：把编译环境留在构建阶段

```dockerfile
# 阶段一：构建
FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app .

# 阶段二：运行
FROM gcr.io/distroless/static-debian12
COPY --from=build /out/app /app
USER nonroot:nonroot
ENTRYPOINT ["/app"]
```

结果：镜像从 800MB 降到 10MB，且不含编译器、包管理器、shell——攻击面小得多。

同类做法：Node 项目 `npm run build` 出静态文件 → 只把 `dist` 拷进 nginx 镜像；Java 用 `maven` 构建 → 只拷 `jar` 进 `jre` 镜像。

### 基础镜像怎么选

| 选择 | 体积 | 适用 |
| --- | --- | --- |
| `alpine` | ~5MB | 静态二进制、需 ldd 时可行 |
| `-slim` | ~70MB | Python/Node 等需要 libc |
| `distroless` | ~2–20MB | 生产首选，无 shell |
| `ubuntu` | ~80MB+ | 需要完整工具链的调试镜像 |

警惕两点：alpine 用 musl libc，某些二进制会跑不起来；distroless 没 shell，进不去容器（这是优点也是缺点，调试时用 `kubectl debug` 或临时换镜像）。

### 必须避免的写法

```dockerfile
# ✗ 每个 RUN 单独 apt update，缓存过期后装包失败
RUN apt-get update
RUN apt-get install -y curl

# ✓ 一条命令，最后清缓存
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# ✗ 把密钥写进镜像
ENV DB_PASS=xxx
COPY .env /app/.env

# ✗ 用 root 跑
USER root
```

`.dockerignore` 也必须有，否则 `COPY . .` 会把 `.git`、`node_modules`、日志一起塞进镜像。

```
.git
node_modules
*.log
.env
```

### 健康检查

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1
```

有健康检查，编排系统才能判断"真的起来了"，而不是"进程还在"。

### 构建与推送

```bash
docker build -t registry.example.com/api:1.0.0 -t registry.example.com/api:latest .
docker login registry.example.com
docker push registry.example.com/api:1.0.0
```

生产只用具体版本号，`latest` 只做别名，不要用来部署。

### 本章验证

1. 给上面的 Python 例子加 `.dockerignore`，对比镜像体积变化。
2. 改一行代码，观察第二次构建是否只重建最后一层。
3. 用多阶段构建把一个 Go 程序打成 distroless 镜像，体积小于 20MB。

镜像构建的功夫全在两件事：**层缓存的顺序**和**最终镜像里少放东西**。
