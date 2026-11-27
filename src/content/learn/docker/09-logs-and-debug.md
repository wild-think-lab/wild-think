---
title: 日志、健康检查与容器排障
module: 熟练篇
summary: 日志驱动与轮转、healthcheck 写法、docker inspect/stats/exec 的用法，以及五个"容器反复重启"的原因。
minutes: 40
---

### 日志：默认是 json-file，会无限长

```json
// /etc/docker/daemon.json
{
  "log-driver": "json-file",
  "log-opts": {"max-size": "50m", "max-file": "5"}
}
```

**"容器日志把磁盘写满"** 是新手最常踩的坑。

**生产建议**：日志走 stdout，由采集器（Fluent Bit/Vector/Promtail）收走，容器本身只保留少量。

### 日志查看

```bash
docker logs --tail 200 -f app
docker logs --since 10m app
docker logs --timestamps app | head
```

**"docker logs 没内容"**：

```
① 应用把日志写进文件（不是 stdout）
② 日志驱动是 none/journald
```

### healthcheck

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -fsS http://localhost:8080/healthz || exit 1
```

```yaml
healthcheck:
  test: ["CMD", "curl", "-fsS", "http://localhost:8080/healthz"]
  interval: 30s
  timeout: 3s
  retries: 3
  start_period: 20s
```

**判据**：

```
starting → 启动中
healthy  → 正常
unhealthy→ 不健康（但容器不会自动重启，需编排层处理）
```

**注意**：`docker` 的 healthcheck 不负责重启；`compose` 可用 `depends_on: condition: service_healthy`。

### 排障四板斧

```bash
docker ps -a                     # 退出码
docker inspect app | jq '.[0].State'
docker stats --no-stream
docker exec -it app sh
```

**退出码**：

| 码 | 含义 |
| --- | --- |
| 0 | 正常退出（但如果是服务，说明它不该退出） |
| 1 | 应用错误 |
| 137 | 被 kill（常见 OOM） |
| 139 | 段错误 |
| 143 | SIGTERM（优雅退出） |

### 五个"容器反复重启"

**① 启动命令立即退出**

```
CMD 写成了前台命令之外的守护式命令 → 进程结束容器就退出
```

**② 依赖未就绪**

```
应用启动时连不上数据库 → 崩 → 重启 → 再崩
（要重试/等待，或用 depends_on）
```

**③ OOM**

```
内存 limit 太小 / 应用内存泄漏（137）
```

**④ 配置/权限**

```
配置文件缺失、目录不可写、非 root 无法绑定 80
```

**⑤ 端口冲突**

```
host 端口已被占用（bind: address already in use）
```

### 一个"能进容器排查"的最小镜像

```bash
docker run --rm -it --network container:app nicolaka/netshoot
```

**`--network container:app`** 共享目标容器的网络命名空间（直接看它的端口与连接）。

### 检查清单

```
□ 日志有大小上限
□ 日志走 stdout（由采集器收）
□ 关键服务有 healthcheck（含 start_period）
□ 知道 137 = OOM
□ 启动依赖有重试/等待
□ 非 root 不绑特权端口
□ 有 netshoot 类调试镜像
□ 有重启次数告警
□ 排障有顺序（状态 → 日志 → 资源 → 网络）
```
