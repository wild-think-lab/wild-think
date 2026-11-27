---
title: Docker Compose：一套服务一个文件
module: 入门篇
summary: 用一份 compose.yaml 起 nginx + api + db + redis，讲清依赖顺序、环境变量注入、健康检查与常用命令。
minutes: 12
---

### 为什么需要 Compose

`docker run` 起三个服务，你要记三条长命令、三个网络参数、四个卷映射。换台机器再敲一遍，必错一处。

Compose 把"这套服务长什么样"写进一个文件，一条命令起停。

### 一份可用的 compose.yaml

```yaml
name: shop

services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: ${DB_PASS:?need DB_PASS}
      POSTGRES_DB: shop
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    restart: unless-stopped

  api:
    build: ./api
    environment:
      DB_HOST: db
      DB_PASS: ${DB_PASS:?need DB_PASS}
      REDIS_HOST: redis
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_started }
    ports:
      - "127.0.0.1:8000:8000"
    restart: unless-stopped

  web:
    image: nginx:1.25
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    ports:
      - "80:80"
    depends_on: [api]

volumes:
  pgdata:
  redisdata:
```

三个关键点：

1. **`${DB_PASS:?need DB_PASS}`**：变量没设就报错退出，避免用空密码起数据库。
2. **`depends_on` + `condition: service_healthy`**：等 db 健康了才起 api。只写 `depends_on: [db]` 只保证"容器启动了"，不代表数据库能连。
3. **`restart: unless-stopped`**：容器崩了自动拉起，但手工 stop 不会反复重启。

### 环境变量从哪来

优先级：shell 环境 > `.env` 文件 > compose 里 `environment` 的默认值。

```bash
# .env（不要提交进 Git）
DB_PASS=Str0ngPass
```

```bash
docker compose config      # 渲染出最终配置，验证变量是否注入成功
```

`config` 是排查"为什么变量没生效"的第一命令。

### 常用命令

```bash
docker compose up -d            # 起全部
docker compose up -d --build    # 重新构建后起
docker compose ps
docker compose logs -f api
docker compose exec api sh
docker compose restart api
docker compose down             # 停并删容器（卷保留）
docker compose down -v          # 连卷一起删（危险）
docker compose pull && docker compose up -d   # 更新镜像
```

`down -v` 会删掉命名卷（数据库数据），生产上必须加确认。

### 依赖顺序不等于就绪

`depends_on` 只控制启动顺序，不解决"服务起来了但还没准备好"。可靠做法是三选一：

1. 应用层重试（最好的做法，代码里加连接重试）。
2. `healthcheck` + `condition: service_healthy`。
3. 启动脚本里 `until nc -z db 5432; do sleep 1; done`。

### 多环境

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d
```

后一个文件覆盖前一个的同名键，用来改资源限制、日志、副本。

### 一个实际排障

"api 一直重启，日志显示连不上 db"：

```bash
docker compose ps                 # 看 db 是否 healthy
docker compose logs db | tail -20 # 看数据库是否初始化失败
docker compose exec db pg_isready -U postgres
docker compose config | grep -i pass   # 密码是否注入
```

多数情况下是 `.env` 没加载（在别的目录执行 compose）或密码里有特殊字符没加引号。

### 本章验证

1. 用上面的文件起 4 个服务，`docker compose ps` 全部 healthy/running。
2. 把 `DB_PASS` 从 `.env` 删掉，确认 compose 报错退出。
3. 停掉 db 容器，观察 api 是否报错并自动重连。

Compose 是"单机多容器"的标准答案。等规模上到多机、要滚动升级时，它自然过渡到 Kubernetes——概念是同一套：服务、依赖、健康检查、卷。
