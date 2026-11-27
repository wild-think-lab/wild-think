---
title: 镜像瘦身与容器排障：把 Docker 真正用明白
module: 入门篇
summary: 镜像从 1.2G 降到 60M 的四个手段，容器起不来时的四类症状与对应命令，以及磁盘爆满的清理顺序。
minutes: 13
---

### 为什么镜像要大

一个 1.2GB 的镜像带来的成本：拉取 3 分钟、占仓库空间、每次部署都在等网络、攻击面大。

先看清里面装了什么：

```bash
docker image ls
docker history --no-trunc registry.example.com/api:1.0.0 | head -20
docker run --rm -it --entrypoint sh image:tag    # 进去看 / 占了多少
```

`docker history` 会把每一层的体积列出来，**通常最大的那层就是答案**。

### 四个瘦身手段

**1. 换基础镜像**

```dockerfile
FROM python:3.12        # 1.0GB
FROM python:3.12-slim   # 130MB
FROM alpine:3.20        # 添加自己需要的依赖，约 60MB
```

**2. 多阶段构建**（编译产物与运行环境分离，前面讲过）

**3. 清缓存写在同一条 RUN 里**

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
```

分开写就成了两层，删掉的文件仍在上一层里占体积。

**4. 排除无用文件**

```
# .dockerignore
.git
node_modules
*.md
tests
```

Python 项目还可以 `pip install --no-cache-dir`，Node 用 `npm ci --omit=dev`。

### 容器起不来的四类症状

**症状一：立刻退出（Exited 1）**

```bash
docker logs <name> --tail 50
docker inspect <name> --format '{{.State.ExitCode}} {{.State.Error}}'
```

常见原因：启动命令路径错、配置文件语法错、缺环境变量、数据库连不上。

**症状二：ExitCode 137**

被 SIGKILL，多半是内存超限：

```bash
docker inspect <name> --format '{{.State.OOMKilled}}'
docker stats --no-stream
```

**症状三：一直 restarting**

```bash
docker events --filter container=<name> --since 10m
```

看事件流里"die → start"的循环，配合日志定位。`restart: always` 会把错误藏起来，测试时先改成 `no`。

**症状四：Running 但访问不通**

按上一章的端口三步查：容器活着 → 端口映射 → 容器内自测。

### 磁盘爆满怎么救

```bash
docker system df -v          # 逐项看：镜像/容器/卷/构建缓存
```

清理顺序（从安全到危险）：

```bash
docker container prune        # 删所有已退出容器
docker image prune            # 删悬空镜像
docker builder prune          # 删构建缓存（通常能省几个 G）
docker volume prune           # 删未被引用的卷（确认没数据再执行）
docker system prune -a --volumes   # 全清（生产禁止随手跑）
```

**日志是最常见的隐形大户**：`/var/lib/docker/containers/*/*-json.log`。修法是在 `daemon.json` 里限制：

```json
"log-opts": { "max-size": "50m", "max-file": "3" }
```

已经写大的日志可以直接截断：`truncate -s 0 <file>`（不要 `rm`，文件被占用不会真正释放）。

### 常用调试技巧

```bash
# 用同一镜像起个 shell，进去看环境
docker run --rm -it --entrypoint sh image:tag

# 看容器真实启动命令
docker inspect <name> --format '{{json .Config.Cmd}} {{json .Config.Entrypoint}}'

# 复制容器内文件出来
docker cp <name>:/app/logs ./logs

# 查看网络与 DNS
docker exec <name> cat /etc/resolv.conf
docker exec <name> getent hosts db
```

### 上线前检查

```
[ ] 镜像有明确 tag，不用 latest
[ ] 以非 root 用户运行
[ ] 有 HEALTHCHECK
[ ] 日志有大小限制
[ ] 数据在卷上
[ ] 资源限制已设置（--memory / compose deploy.resources）
[ ] 镜像里没有密钥（用环境变量或 secret）
```

### 本章验证

1. 把一个镜像的 `docker history` 拆开，找出最大层并说明来源。
2. 用多阶段构建把镜像压到原来的 1/5。
3. 制造一个 OOM 场景（`--memory 100m` 跑一个吃内存的程序），确认 ExitCode 137 与 `OOMKilled=true`。

到这里 Docker 这条线闭环了：**跑起来 → 打成镜像 → 挂数据 → 组服务 → 瘦身排障**。再往上是 K8s，但底层的镜像、卷、网络概念完全一致。
