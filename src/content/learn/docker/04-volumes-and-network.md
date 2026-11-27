---
title: 卷与网络：容器之间怎么互相找到
module: 入门篇
summary: 卷的三种类型与选型、桥接网络为什么同名容器能互 ping、端口到底映射到哪一层，以及"容器连不上数据库"的排查顺序。
minutes: 12
---

### 数据持久化的三种方式

| 方式 | 写法 | 适用 | 注意 |
| --- | --- | --- | --- |
| 命名卷 | `-v pgdata:/var/lib/postgresql/data` | 数据库、需要备份的数据 | Docker 管理，位置在 `/var/lib/docker/volumes` |
| 绑定挂载 | `-v /data/logs:/var/log/app` | 配置文件、日志、需要查看的文件 | 权限/UID 要对上 |
| tmpfs | `--tmpfs /tmp` | 纯临时、极快 | 重启即失 |

选型口诀：**数据库用命名卷，配置和日志用绑定，临时用 tmpfs。**

### 卷的备份与恢复（很实用但常被忽略）

```bash
# 备份一个命名卷
docker run --rm -v pgdata:/from -v "$PWD":/backup alpine \
  tar czf /backup/pgdata-$(date +%F).tar.gz -C /from .

# 恢复
docker run --rm -v pgdata:/to -v "$PWD":/backup alpine \
  sh -c 'rm -rf /to/* && tar xzf /backup/pgdata-2026-11-27.tar.gz -C /to'
```

容器只是个临时的 tar 工具人，这种用法很常见。

### 网络：默认发生了什么

```bash
docker network ls
docker network inspect bridge | head -30
```

Docker 默认创建 `bridge` 网络。同一自定义网络里的容器**可以用容器名互相访问**，这是最大的便利。

```bash
docker network create appnet
docker run -d --name db --network appnet -e POSTGRES_PASSWORD=*** postgres:16
docker run -d --name api --network appnet -e DB_HOST=db myapi:1.0
```

关键点：**`DB_HOST=db` 能解析，是因为它们在同一个用户自定义网络上**。默认 `bridge` 网络不支持按名字解析——这是新手最常踩的坑。

### 端口映射到底映射到哪

```bash
docker run -d -p 127.0.0.1:8080:80 nginx
```

`宿主IP:宿主端口:容器端口`。三个变体：

- `-p 8080:80` → 监听所有网卡（0.0.0.0），外部可访问。
- `-p 127.0.0.1:8080:80` → 只允许本机访问（安全默认值）。
- `-p 8080:80/udp` → UDP。

容器之间通信**不需要端口映射**，直接用容器名 + 容器端口即可。映射只是为了宿主机/外部访问。

### 排查"容器连不上数据库"

按顺序：

```bash
# 1. 在同一网络里吗
docker inspect api --format '{{json .NetworkSettings.Networks}}'

# 2. 名字能解析吗
docker exec api getent hosts db

# 3. 端口通吗（用容器内工具测）
docker exec api sh -c 'nc -zv db 5432 || timeout 3 bash -c "echo > /dev/tcp/db/5432"'

# 4. 对端在监听吗
docker exec db ss -tlnp
```

四步能定位 90% 的问题：网络不同 → 名字不通 → 端口不通 → 服务没监听。

### 一个常见误会：数据库只监听 localhost

Postgres 官方镜像默认监听 `0.0.0.0`，但很多自建镜像会把 `bind_address` 写成 `127.0.0.1`。容器里 `127.0.0.1` 只是容器自己，于是"宿主机能连、其他容器连不上"。

判断方法：`docker exec db ss -tlnp`，看是 `127.0.0.1:5432` 还是 `0.0.0.0:5432`。

### 本章验证

1. 建 `appnet`，起 db 与 api 两个容器，用名字互 ping。
2. 把 api 换到默认 bridge 网络，确认按名字解析失败（理解原因）。
3. 用临时容器备份一个命名卷，再恢复到新卷并验证数据。

卷和网络是容器里最容易"看起来能用但实际不对"的部分。**先把名字解析和监听地址搞清，剩下的都好办。**
