---
title: 容器生产实践：资源、重启与可观测
module: 进阶篇
summary: CPU/内存限制、重启策略、健康检查、日志驱动与 pid 模式，五个"本地能跑生产炸"的原因。
minutes: 45
---

### 资源限制（不加就是抢整机）

```bash
docker run -d \
  --cpus=2 \
  --memory=2g --memory-swap=2g \
  --pids-limit=200 \
  --ulimit nofile=65535:65535 \
  app:1.0
```

```
① --memory 不设 → 容器能吃光宿主机内存
② memory-swap 等于 memory → 禁用交换（避免慢死）
③ pids-limit → 防 fork 炸弹
```

**注意**：Java 容器要 `-XX:MaxRAMPercentage=75`（别用固定 -Xmx）。

### 重启策略

```bash
--restart=unless-stopped
```

```
no：不重启（默认）
on-failure：非 0 退出才重启
always：总是
unless-stopped：除非手动停
```

**"用 always + 启动就崩"** → 无限重启循环，要看 `RestartCount` 与日志。

### 健康检查

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
```

```
① start-period 给启动留时间（不然一上来就 unhealthy）
② 检查"就绪"而不是"端口通"
③ unhealthy 不等于自动重启（需要外部编排）
```

### 日志驱动

```bash
docker run --log-driver=json-file --log-opt max-size=50m --log-opt max-file=3
```

**"默认 json-file 不限大小"** → /var/lib/docker 涨满磁盘。

**更好**：日志走 stdout → 采集器（见可观测性篇）。

### 网络与隔离

```bash
docker network create app-net
docker run --network app-net --name db ...
docker run --network app-net --name api ...
# 只暴露需要的端口
docker run -p 127.0.0.1:8080:8080 app
```

**`-p 8080:8080`** 默认监听 0.0.0.0（公网可达）。

### 存储与数据

```bash
docker run -v /data/app:/app/data app
# 或用命名卷
docker run -v app-data:/app/data app
```

**"数据写在容器层"** → 删除容器就没了，且性能差。

### 五个"本地能跑生产炸"

**① 没限资源**

```
一台容器把宿主机拖垮
```

**② 用 root + 可写根**

```
风险放大，且容器层写满
```

**③ 时区/编码**

```
日志时间错、中文乱码
```

```bash
-e TZ=Asia/Shanghai -e LANG=C.UTF-8
```

**④ 依赖 localhost**

```
容器内 127.0.0.1 是自己，不是宿主机
```

**⑤ 没健康检查**

```
进程活着但服务不可用，流量还在打
```

### 检查清单

```
□ CPU/内存/pids/ulimit 都设了
□ JVM 用 MaxRAMPercentage
□ restart 策略明确
□ 健康检查分就绪/存活
□ 日志有大小限制或走采集
□ 只用必要端口且绑 127.0.0.1
□ 数据用卷/挂载
□ 非 root 运行
□ TZ/LANG 设置
□ 有 RestartCount 与 unhealthy 告警
```
