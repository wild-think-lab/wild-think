---
title: 装 Docker 与第一个自己的容器
module: 入门篇
summary: 安装、免 sudo、配置镜像加速、跑起第一个自定义服务容器，并知道"容器起来了但访问不到"先查哪三件事。
minutes: 11
---

### 安装

**Ubuntu/Debian（官方脚本最省事）**：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
docker version
```

**Rocky/CentOS**：

```bash
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
```

装完必做：**把自己的用户加入 docker 组**，否则每条命令都要 sudo。

```bash
sudo usermod -aG docker $USER
newgrp docker          # 或重新登录
docker ps
```

注意：`docker` 组等价于 root 权限（能挂载宿主目录），生产上要控制成员。

### 配置（可选但强烈建议）

`/etc/docker/daemon.json`：

```json
{
  "registry-mirrors": ["https://<你的加速地址>"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" },
  "data-root": "/data/docker"
}
```

第二条最关键：**不限制日志大小，一个容器能写满磁盘**——这是容器环境最常见的磁盘爆满原因。

```bash
sudo systemctl daemon-reload && sudo systemctl restart docker
docker info | grep -A2 'Log'
```

### 第一个自定义容器

建个目录：

```bash
mkdir -p ~/lab/web && cd ~/lab/web
cat > index.html <<'EOF'
<h1>hello from container</h1>
EOF
```

用官方 nginx 挂载静态文件：

```bash
docker run -d --name hello -p 8080:80 \
  -v "$PWD/index.html:/usr/share/nginx/html/index.html:ro" \
  nginx:1.25
curl -s http://127.0.0.1:8080
```

`:ro` 是只读挂载，防止容器写坏宿主文件。

### 访问不到？按这三步查

1. **容器活着吗**

```bash
docker ps -a | grep hello
docker logs hello --tail 30
```

2. **端口映射对吗**

```bash
docker port hello                 # 80/tcp -> 0.0.0.0:8080
ss -tlnp | grep 8080
```

3. **容器内部通吗**

```bash
docker exec hello curl -s localhost          # 容器内自测
```

如果容器内通、宿主机不通 → 端口映射或防火墙；都不通 → 服务没监听在 0.0.0.0（很多程序默认只听 127.0.0.1，容器里就变成只听容器自己的 loopback）。

### 常用运维命令

```bash
docker stats                       # 实时资源
docker inspect hello --format '{{json .NetworkSettings.Ports}}'
docker cp hello:/etc/nginx/nginx.conf ./nginx.conf   # 拷出来看
docker system df                  # 磁盘占用（镜像/容器/卷/缓存）
docker system prune -a --volumes   # 清理（危险，先看清）
```

`docker system df` 是磁盘告警时的第一命令：经常是"悬空镜像 + 构建缓存"占了几个 G。

### 本章验证

1. 装好 Docker，`docker ps` 不需要 sudo。
2. 用挂载方式跑一个静态页面，改宿主的 html 后刷新立即生效。
3. `docker system df` 输出里能解释每一列的含义。

装完这一章，你已经有了能用的环境。下一步是把它变成"一条命令构建、任何机器上都能跑"的镜像。
