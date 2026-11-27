---
title: 容器安全与资源限制：别让容器变成 root 后门
module: 熟练篇
summary: 非 root 运行、capabilities、只读根文件系统、资源限制与七个"容器逃逸/被利用"的常见配置。
minutes: 45
---

### 默认的危险

```
容器里默认是 root
默认有一批 capabilities
默认根文件系统可写
默认可以访问 /var/run/docker.sock（如果挂进去）
```

**"容器是隔离的"** 不等于"安全"。

### 非 root 运行

```dockerfile
FROM alpine:3.19
RUN adduser -D -u 10001 app
USER 10001
ENTRYPOINT ["/app/server"]
```

```yaml
# compose
user: "10001:10001"
```

**"USER 写在最后一行之前"** 会影响后续 COPY 的属主（注意顺序）。

### capabilities：只留必要

```yaml
cap_drop: ["ALL"]
cap_add: ["NET_BIND_SERVICE"]   # 只有需要绑 80 时才加
```

**"privileged: true"** 等于把宿主机交给容器（除非调试，绝不用于生产）。

### 只读根文件系统

```yaml
read_only: true
tmpfs: ["/tmp"]
```

**好处**：攻击者无法落地工具；应用只写需要写的地方（挂卷）。

### 资源限制（防"一个容器拖垮整机"）

```yaml
deploy:
  resources:
    limits: {cpus: "2", memory: 1g}
    reservations: {memory: 512m}
```

**判据**：

```
memory limit 超 → OOM kill（容器退出码 137）
cpus 限制 → 被 CFS 限流（延迟抖动）
```

```bash
docker stats --no-stream
docker inspect --format '{{.State.OOMKilled}}' <container>
```

### 七个危险配置

```
① privileged: true
② 挂载 /var/run/docker.sock（等于宿主 root）
③ 挂载 / 或 /etc 到容器
④ pid: host / network_mode: host（视需要）
⑤ 容器内跑 sshd 且密码登录
⑥ 镜像来自不可信仓库
⑦ 用 root + 可写根 + 无 seccomp
```

**"挂 docker.sock"** 是最常见的"为了方便"换来的"完全失守"。

### seccomp 与 no-new-privileges

```yaml
security_opt:
- no-new-privileges:true
- seccomp:default.json     # 或默认 Docker 配置
```

### 日志与审计

```bash
docker logs --tail 100 app
docker events --filter 'type=container' --since 10m
```

**"容器被 reset 了没记录"** → 至少要有日志集中收集。

### 检查清单

```
□ 非 root 运行
□ cap_drop ALL + 按需 add
□ 只读根 + tmpfs 放临时
□ 有 memory/cpus 限制
□ 不 privileged
□ 不挂 docker.sock
□ 不挂宿主机敏感目录
□ no-new-privileges
□ 镜像来自可信仓库且有扫描
□ 日志集中收集
□ 有 OOM/重启告警
```
