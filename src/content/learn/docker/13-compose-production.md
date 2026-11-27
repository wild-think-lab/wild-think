---
title: Compose 生产实践：一套服务端到端跑起来
module: 进阶篇
summary: 生产可用的 compose 结构、变量与密钥、健康检查依赖、日志与更新，五个"compose 只能本地玩"的原因。
minutes: 45
---

### 一个生产可用的骨架

```yaml
services:
  db:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PWD}
      MYSQL_DATABASE: app
    volumes:
      - db-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 40s

  api:
    image: registry.example.com/app:${TAG}
    restart: unless-stopped
    env_file: .env
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "127.0.0.1:8080:8080"
    logging:
      driver: json-file
      options: { max-size: "50m", max-file: "3" }

volumes:
  db-data:
```

**关键点**：

```
① depends_on 用 condition: service_healthy（不是只排序）
② 端口绑 127.0.0.1，对外交给反代
③ 日志限大小
④ 镜像用带 tag 变量（不用 latest）
```

### 变量与密钥

```bash
# .env
TAG=1.4.2
DB_ROOT_PWD=***
```

```bash
docker compose --env-file .env.prod up -d
```

**"把密码写进 compose 并提交"** → 泄露；用 `.env` 且 `.gitignore`。

### 更新与回滚

```bash
docker compose pull
docker compose up -d --no-deps api     # 只更新 api
docker compose ps
```

**回滚**：

```bash
TAG=1.4.1 docker compose up -d --no-deps api
```

**判据**：镜像 tag 可回溯是回滚的前提。

### 多环境

```
compose.yml          基础
compose.override.yml 本地开发（挂载源码、端口全开）
compose.prod.yml     生产（资源限制、日志、密钥）
```

```bash
docker compose -f compose.yml -f compose.prod.yml up -d
```

### 五个"只能本地玩"

**① 没有健康检查依赖**

```
api 先起，db 没就绪 → 启动即崩
```

**② 没用 restart 策略**

```
宿主机重启后全挂
```

**③ 端口全暴露**

```
-p 3306:3306 直接对公网
```

**④ 无资源限制**

```
一个容器吃光内存
```

```yaml
    deploy:
      resources:
        limits: { cpus: "2", memory: 2G }
```

**⑤ 数据在容器层**

```
down 之后数据没了
```

### 五个"生产事故"

```
① 忘记 --no-deps → 连带重启 DB
② compose down -v → 删卷（数据没了）
③ 用 latest 拉到了不兼容版本
④ 日志无限增长
⑤ 单机 compose 无高可用（机器挂就全挂）
```

### 检查清单

```
□ 镜像 tag 明确（可回滚）
□ 密钥走 .env（不入库）
□ depends_on 带 healthy 条件
□ 有 healthcheck 与 start_period
□ 端口只绑 127.0.0.1（或内网）
□ 有资源限制
□ 日志有大小限制
□ 数据在命名卷/挂载
□ 更新用 --no-deps
□ 知道单机上限（要 HA 就上编排）
```
