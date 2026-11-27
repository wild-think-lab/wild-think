---
title: Docker 速查
summary: 镜像、容器、网络、卷、清理与排障：最常用的命令配上"什么时候该用哪条"，以及容器里没 ps/curl 时怎么查。
group: 容器
order: 5
tags: [Docker, 容器, 镜像, 排障]
---

## 镜像

```bash
docker pull nginx:1.27-alpine
docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}'
docker history --no-trunc nginx:1.27-alpine | head -20   # 每层怎么来的
docker inspect -f '{{.Config.Entrypoint}} {{.Config.Cmd}}' nginx:1.27-alpine
docker tag local/app:dev registry.example.com/team/app:1.2.0
docker push registry.example.com/team/app:1.2.0
```

`docker history` 是排查"镜像为什么 2GB"的第一步：每一层都列出来了。

## 容器

```bash
docker run -d --name api \
  -p 8080:8080 \
  -e TZ=Asia/Shanghai -e LOG_LEVEL=info \
  -v /data/app:/app/data \
  --restart unless-stopped \
  --memory 1g --cpus 2 \
  registry.example.com/team/app:1.2.0

docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker exec -it api sh
docker logs -f --tail=200 api
docker stats --no-stream
docker inspect api -f '{{.State.ExitCode}} {{.State.OOMKilled}}'
```

退出码与 `OOMKilled` 一起看：137 + `OOMKilled: true` 就是内存超限。

## 容器里没工具怎么办

这是最常见的问题。三种解法：

```bash
# 1. 用带工具的同网络临时容器
docker run --rm -it --network container:api nicolaka/netshoot

# 2. 拷工具进去
docker cp /usr/bin/curl api:/tmp/curl

# 3. 看宿主机侧的进程与网络（不依赖镜像内容）
nsenter -t $(docker inspect -f '{{.State.Pid}}' api) -n ss -lntp
cat /proc/$(docker inspect -f '{{.State.Pid}}' api)/root/etc/hosts
```

`nsenter` 那招在 distroless/alpine 精简镜像里特别管用。

## 网络

```bash
docker network ls
docker network inspect bridge -f '{{json .Containers}}' | jq
docker run --rm --network host nicolaka/netshoot ss -lntp
docker network create app-net
docker run -d --name db --network app-net postgres:16
```

自定义 bridge 网络里，容器之间可以用**容器名当域名**互访；默认 `bridge` 不行。这条能解释一大半"连不上另一个容器"的问题。

## 卷

```bash
docker volume ls
docker volume inspect app-data
docker run --rm -v app-data:/data -v $PWD:/backup alpine tar czf /backup/app.tar.gz -C /data .
docker run --rm -v app-data:/data alpine sh -c 'ls -lh /data'
```

**匿名卷（`docker run -v /data`）很容易被遗忘**，容器删了卷还在，久了就是几十 GB 垃圾。

## 清理

```bash
docker system df -v                 # 先看谁占空间
docker container prune              # 已停止的容器
docker image prune -a               # 没被任何容器使用的镜像（危险，确认后再跑）
docker builder prune --keep-storage 10GB
docker system prune -a --volumes    # 全清（会删卷，务必先确认）
```

生产环境别用 `-a --volumes` 一把梭。先 `df -v`，再针对列表。

## 构建

```bash
docker build -t app:dev -f Dockerfile.prod .
docker build --build-arg HTTP_PROXY=http://proxy:3128 -t app:dev .
docker build --no-cache --progress=plain -t app:dev .   # 排查缓存问题
```

多阶段构建的缓存关键在 `COPY go.mod go.sum` 放在 `RUN download` 之前——顺序错了每次都要重下依赖。

`.dockerignore` 必须写，否则 `COPY . .` 会把 `node_modules`、`.git` 一起带进去，镜像直接翻倍。

## 一眼看问题的组合

```bash
docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restart={{.HostConfig.RestartPolicy.Name}}' api
docker logs api 2>&1 | tail -50
docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' api
```
