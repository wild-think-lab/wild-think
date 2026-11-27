---
title: 部署应用运行时：Java / Node / Python 上线
module: 熟练篇
summary: 三种运行时的安装与 systemd 托管、JVM 内存、Node 进程管理、Python 虚拟环境，以及五个"能跑但上线就挂"的原因。
minutes: 50
---

## 一、先弄懂"运行时"是什么

**运行时 = 让代码跑起来的那一层：语言虚拟机 + 依赖库 + 进程管理。**

```
代码 → 运行时（JVM / Node / CPython）→ 操作系统 → 硬件
         ↑ 负责内存管理、线程调度、GC、IO 封装
```

**为什么部署要懂它**：几乎所有"能跑但上线就挂"的问题，都发生在运行时这一层——内存上限算错、GC 停顿、线程池打满、信号没接。

### 三种运行时的关键机制

| 运行时 | 内存模型 | 并发模型 | 常见坑 |
| --- | --- | --- | --- |
| JVM | 堆 + 元空间 + 直接内存，分代 GC | 线程（平台线程/虚拟线程） | `-Xmx` 给太大被容器 OOM、GC 停顿 |
| Node | 堆有上限（默认约 2-4GB 随架构） | 单线程事件循环 + 线程池 | CPU 密集阻塞所有请求 |
| CPython | 引用计数 + 循环 GC | GIL（同一时刻一个线程执行字节码） | 多线程不提升 CPU 并行，要用多进程 |

**判据**：

```
Java 容器内存 = 堆 + 元空间 + 线程栈 + 直接内存 + 代码缓存
→ MaxRAMPercentage=75 是留余量，不是保守
```

### 进程管理为什么必须交给 systemd

```
screen/nohup：会话结束就死、崩溃不拉起、开机不自启
systemd：开机自启、失败重启、日志进 journal、可限资源（cgroup）
```

### 优雅退出（SIGTERM 到底发生了什么）

```
systemd stop → 发 SIGTERM → 应用停止接新请求、处理完在途请求 → 退出
超时（TimeoutStopSec）→ SIGKILL（强杀，请求被砍）
```

**判据**：`SuccessExitStatus=143`（143 = 128+15）表示"被 SIGTERM 正常终止"，不算失败。

### 反向代理为什么必须加

```
应用只管业务；TLS、限流、统一日志、跨域、压缩交给 Nginx
```

### Java：装 JDK 并托管

```bash
dnf install -y java-17-openjdk-headless
java -version
```

```ini
# /etc/systemd/system/app.service
[Unit]
Description=App
After=network-online.target

[Service]
User=app
WorkingDirectory=/opt/app
Environment=JAVA_OPTS="-Xms512m -Xmx1g -XX:+UseG1GC"
ExecStart=/usr/bin/java -jar /opt/app/app.jar
Restart=on-failure
RestartSec=5
SuccessExitStatus=143
```

**要点**：

```
① headless 包（服务器不需要 GUI）
② -Xmx 要小于容器/机器内存（留堆外与元空间）
③ SuccessExitStatus=143（SIGTERM 退出不算失败）
```

### Node：别用 npm start 裸跑

```bash
dnf install -y nodejs
npm ci --omit=dev
```

```ini
[Service]
User=app
WorkingDirectory=/opt/app
ExecStart=/usr/bin/node /opt/app/dist/server.js
Environment=NODE_ENV=production
Restart=on-failure
```

**"node server.js 跑在 screen 里"** → 重启机器就没了、崩了没人拉。

**更推荐**：容器化或用 `pm2`（但 systemd 已经够用）。

### Python：虚拟环境 + gunicorn

```bash
python3 -m venv /opt/app/venv
/opt/app/venv/bin/pip install -r requirements.txt
```

```ini
[Service]
User=app
WorkingDirectory=/opt/app
ExecStart=/opt/app/venv/bin/gunicorn -w 4 -k gthread --threads 4 \
  -b 127.0.0.1:8080 app:app
```

**`-w` 的算法**：

```
workers = (2 × 核数) + 1（IO 密集可更多，内存要够）
```

**"用 root 跑 pip install"** → 依赖装到系统环境，多项目互相污染。

### 反向代理（统一入口）

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

**"应用直接对外 8080"** → 少了 TLS、限流、日志统一。

### 五个"能跑但上线就挂"

**① 内存超限**

```
JVM 默认堆按物理内存算 → 容器里被 OOM
```

**② 文件描述符不够**

```
高并发时 Too many open files
```

```conf
# limits.conf 或 systemd
LimitNOFILE=65535
```

**③ 时区/编码**

```
日志时间差 8 小时、中文乱码
```

**④ 依赖缺失**

```
本地有全局包，服务器没有（要用锁文件）
```

**⑤ 没设优雅退出**

```
重启时正在处理的请求被中断
```

```ini
KillSignal=SIGTERM
TimeoutStopSec=30
```

### 检查清单

```
□ 用 systemd 托管（不是 screen/nohup）
□ 专用非 root 用户
□ 依赖用锁文件安装
□ JVM/进程内存有上限
□ file descriptor 上限已调
□ 时区与编码统一
□ 有反向代理（TLS/限流）
□ 优雅退出（SIGTERM + 超时）
□ 日志进 journal 或文件（有轮转）
□ 有健康检查与重启验证
```
