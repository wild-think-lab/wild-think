---
title: 容器不是虚拟机：先破除三个误解
module: 入门篇
summary: 镜像、容器、仓库三个词到底指什么，容器为什么比虚拟机轻，以及"容器里数据会不会丢"这个最常问的问题。
minutes: 12
---

### 三个误解

**误解一：容器是轻量虚拟机。**
不是。容器里没有独立的操作系统内核，它跑在宿主机的内核上。虚拟机要模拟整台电脑，容器只是**隔出一块进程空间**。

**误解二：容器隔离很彻底。**
从进程、网络、文件系统看是的，但内核是共享的。一个容器逃逸漏洞可能影响整机，这也是"容器安全"要单独做的原因。

**误解三：容器里的数据会自己保存。**
不会。容器删了，里面的写入全丢。数据必须放卷（volume）或外部存储。

### 三个词的关系

| 词 | 类比 | 说明 |
| --- | --- | --- |
| 镜像 image | 光盘 | 只读模板，分层存储 |
| 容器 container | 光盘跑起来的进程 | 镜像 + 可写层 + 运行时 |
| 仓库 registry | 光盘店 | 存放与分发镜像 |

```bash
docker pull nginx:1.25        # 从仓库拉镜像
docker run -d nginx:1.25      # 镜像 → 容器
docker images                 # 本地镜像列表
docker ps -a                  # 所有容器（含已退出）
```

### 为什么它比虚拟机轻

- 虚拟机：起一个完整 OS，启动几十秒，占用 GB 级。
- 容器：起一个进程，启动毫秒级，占用 MB 级。

原因是**共享内核**。这也决定了容器的适用边界：需要不同内核版本、需要强隔离时，还是得上虚拟机。

### 镜像分层：理解它才能理解构建缓存

```
nginx:1.25
 ├─ 基础层: debian
 ├─ 层: apt install 依赖
 ├─ 层: 拷贝配置
 └─ 层: 启动命令（CMD）
```

每一层只读，多层共享。改一层之后的层全部要重建——这就是 Dockerfile 里"把不变的放前面"的原因。

```bash
docker history nginx:1.25
docker image inspect nginx:1.25 | head -40
```

### 第一次运行

```bash
docker run --rm -it alpine sh
# 里面是个精简的 shell，exit 后容器消失
```

参数含义：

| 参数 | 作用 |
| --- | --- |
| `-d` | 后台运行 |
| `-it` | 交互 + 终端 |
| `--rm` | 退出即删（测试时最常用） |
| `-p 8080:80` | 宿主 8080 → 容器 80 |
| `-v /data:/data` | 挂载目录 |
| `--name web` | 指定名字 |
| `-e KEY=value` | 环境变量 |

```bash
docker run -d --name web -p 8080:80 nginx:1.25
curl -I http://127.0.0.1:8080
docker logs -f web
docker exec -it web sh
```

### 数据到底放哪

```bash
docker run -d --name db -v pgdata:/var/lib/postgresql/data postgres:16
docker volume ls
docker volume inspect pgdata
```

- **命名卷**（`pgdata`）：由 Docker 管理，删容器不删卷。
- **绑定挂载**（`-v /host/path:/container/path`）：宿主机目录直接映射，便于查看文件。

规则：**有状态的东西一律挂卷**，别指望容器自己记住。

### 容器生命周期

```bash
docker stop web      # 发 SIGTERM，10 秒后 SIGKILL
docker start web
docker restart web
docker rm -f web     # 强制删
docker logs web --tail 50
docker inspect web --format '{{.State.Status}} {{.State.ExitCode}}'
```

`ExitCode 137` = 被 SIGKILL（OOM 或强制杀）；`143` = 正常收到 SIGTERM。看懂退出码能省很多排查时间。

### 本章验证

1. 拉起一个 nginx 容器，映射到 8080，用 curl 验证。
2. 用 `-v` 挂载一个空目录到 nginx 的 html 目录，放一个 index.html，看是否生效。
3. 删掉容器后用命名卷重建，确认数据还在。

理解这三层关系（镜像 → 容器 → 卷），后面写 Dockerfile 才不会"每次构建都慢、每次重启都丢数据"。
