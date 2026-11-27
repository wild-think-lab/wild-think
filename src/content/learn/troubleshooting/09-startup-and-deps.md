---
title: 启动失败与依赖问题排查
module: 熟练篇
summary: 服务起不来的六个常见原因、依赖顺序与健康检查，以及串行排查的固定顺序。
minutes: 45
---

### 起不来的六个原因

```
① 配置错误（语法/必填项/路径）
② 端口被占
③ 权限（文件/目录/绑定低端口）
④ 依赖没起（DB/缓存/下游）
⑤ 资源不足（内存/磁盘/文件描述符）
⑥ 版本/依赖库缺失
```

### 固定排查顺序

```bash
systemctl status app -l --no-pager
journalctl -u app -n 80 --no-pager
ss -lntp | grep 8080
df -h | tail -3
ulimit -n
```

**"先看日志头 20 行"** 往往就能直接看到原因。

### 逐类判据

**① 配置**

```bash
nginx -t
named-checkconf
python -c "import yaml; yaml.safe_load(open('config.yaml'))"
```

**② 端口**

```bash
ss -lntp | grep -E ':8080|:80'
fuser -n tcp 8080
```

**③ 权限**

```bash
ls -ld /opt/app /var/log/app
# 低端口（<1024）需要 root 或 CAP_NET_BIND_SERVICE
```

**④ 依赖**

```bash
nc -zv 10.0.0.21 3306
redis-cli -h 10.0.0.22 ping
```

**⑤ 资源**

```bash
free -m
df -h
cat /proc/<pid>/limits | grep "open files"
```

**⑥ 版本/库**

```bash
ldd /opt/app/app | grep "not found"
java -version
```

### 依赖顺序与等待

```
DB → 缓存 → MQ → 应用 → 网关
```

```ini
# systemd 里不要只写 After，还要能重试
[Unit]
After=network-online.target

[Service]
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=0
```

**"依赖慢启动，应用一启动就退出"** → 用重试或探活等待，不要靠 `sleep 30`。

### 健康检查要分层

```bash
# 存活（进程还活着）
curl -f http://127.0.0.1:8080/healthz
# 就绪（依赖都通）
curl -f http://127.0.0.1:8080/readyz
```

**"只检查端口通"** → 端口通但 DB 连不上，仍然不可用。

### 五个"重启就好了，然后复发"

**① 内存泄漏**

```
重启释放，几小时后再次 OOM
```

**② 连接池泄漏**

```
重启清空，逐渐打满
```

**③ 磁盘慢满**

```
日志/binlog 未轮转
```

**④ 依赖间歇不可用**

```
上游抖动 → 应用没重试
```

**⑤ 定时任务堆积**

```
cron 每分钟起一个，重叠执行
```

**判据**："重启有效"说明状态在累积，要找出累积的是什么。

### 检查清单

```
□ 先看 status + journal（不猜）
□ 配置做语法检查
□ 端口冲突已排除
□ 权限与 SELinux 已确认
□ 逐个依赖做连通测试
□ 资源（内存/磁盘/fd）已确认
□ 用重试/探活代替 sleep
□ 健康检查分存活与就绪
□ 重启后观察至少 30 分钟
□ 累积型问题已记录并跟踪
```
