---
title: Python Web 服务上生产：从 demo 到能扛住
description: 开发服务器为什么不能上生产、WSGI/ASGI 与 worker 数的算法、Nginx 前置的必要性、以及"改了代码不生效"的四种原因。
date: 2023-11-02
tags: [Python, Web, 部署, Gunicorn]
---

### `flask run` 为什么不能上生产

```
① 单进程单线程（或开发用 reloader）→ 并发能力极低
② 没有进程管理（崩了不会自动拉起）
③ reloader 会监控文件变化 → 生产上白白消耗资源
④ 官方明确说"不要用于生产"
```

### WSGI vs ASGI

| | WSGI | ASGI |
| --- | --- | --- |
| 同步/异步 | 同步 | 支持异步 |
| 服务器 | Gunicorn / uWSGI | Uvicorn / Hypercorn |
| 框架 | Flask、Django（同步） | FastAPI、Starlette、Django（3.0+ 异步） |
| 长连接 | 不支持 WebSocket | 支持 |

**选择**：

```
Flask/Django 同步 → Gunicorn
FastAPI/需要 WebSocket → Uvicorn（可用 Gunicorn 做进程管理）
```

### worker 数怎么算

经验公式：

```
workers = (2 × CPU 核数) + 1
```

但更准确的是看"IO 等待比例"：

```
CPU 密集（大量计算）→ workers ≈ 核数 + 1
IO 密集（等数据库/HTTP）→ workers 可以到 核数 × 4
```

内存约束（更重要）：

```
workers × 单 worker 内存 < 容器内存上限（留 30% 余量）
例：单 worker 200MB，容器 2G → 最多 7 个 worker
```

Gunicorn 配置：

```python
# gunicorn.conf.py
bind = "0.0.0.0:8000"
workers = 4
worker_class = "sync"          # 异步用 "uvicorn.workers.UvicornWorker"
threads = 4                    # sync worker 下每 worker 线程数
timeout = 30
graceful_timeout = 30
max_requests = 2000            # 防内存泄漏（处理 N 个请求后重启 worker）
max_requests_jitter = 200
accesslog = "-"
errorlog = "-"
loglevel = "info"
```

`max_requests` 是**防内存泄漏的实用手段**：Python 服务长期运行内存会缓慢增长，定期重启 worker 能限制上限。

### 为什么要在前面放 Nginx

```
① TLS 终止（Python 服务器做 TLS 性能差、配置麻烦）
② 静态文件（Nginx 直接发，比 Python 快 10 倍）
③ 缓冲慢客户端（避免 worker 被慢连接占住）
④ 限流、压缩、缓存
⑤ 多应用路由（同一域名不同路径）
```

```nginx
upstream app {
    server 127.0.0.1:8000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name app.example.com;

    location /static/ {
        alias /opt/app/static/;
        expires 30d;
        access_log off;
    }

    location / {
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        proxy_buffering on;
    }
}
```

**`proxy_set_header X-Forwarded-*` 必须配**：否则应用拿到的客户端 IP 都是 127.0.0.1，日志与限流全部失真。

### 系统服务（自动重启）

```ini
# /etc/systemd/system/app.service
[Unit]
Description=app
After=network.target

[Service]
Type=simple
User=app
WorkingDirectory=/opt/app
Environment="PATH=/opt/app/venv/bin"
ExecStart=/opt/app/venv/bin/gunicorn -c gunicorn.conf.py app:app
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now app
systemctl status app
```

### 依赖与虚拟环境

```bash
python3 -m venv /opt/app/venv
/opt/app/venv/bin/pip install -r requirements.txt
```

**生产上必须锁定版本**：

```
requirements.txt 里写死版本（==），不要用 >=
更好：用 pip-tools 生成 requirements.txt（含全部传递依赖）
```

### "改了代码不生效"的四种原因

| 原因 | 排查 |
| --- | --- |
| 没重启 worker | `systemctl restart app`；或配 `--reload`（仅开发用） |
| 改的是错误的目录 | 确认 `WorkingDirectory` 与实际代码位置 |
| 多台机器只改了一台 | 检查负载均衡后的所有实例 |
| Python 缓存 `.pyc` 与旧版本冲突 | 删 `__pycache__`（少见，但确实遇到） |
| CDN/浏览器缓存静态文件 | 文件名加 hash，或改 `expires` |

**最实用的判断**：在代码里加一个版本号接口。

```python
@app.get("/version")
def version():
    return {"version": "1.4.2", "build": "a1b2c3d"}
```

改了代码后先打这个接口，确认新版本已生效。

### 健康检查与优雅退出

```python
@app.get("/health")
def health():
    # 只检查"进程能响应"，不要检查数据库（避免误杀）
    return {"status": "ok"}
```

Gunicorn 的优雅退出：

```python
graceful_timeout = 30      # 收到 SIGTERM 后，等 30 秒处理完存量请求
```

配合 K8s 的 `preStop` 和 `terminationGracePeriodSeconds`，可以做到零中断发布。

### 内存与性能观测

```bash
# 内存
ps -o pid,rss,cmd -C gunicorn
# 每个 worker 的 RSS 长期增长 → 有泄漏
```

排查泄漏：

```bash
pip install memory_profiler
python -m memory_profiler app.py
# 或用 objgraph / tracemalloc
```

### 检查清单

```
□ 不用 `flask run` / `manage.py runserver` 上生产
□ worker 数按内存约束算（留 30% 余量）
□ 配 `max_requests` 防内存泄漏
□ 前置 Nginx（TLS、静态、缓冲）
□ 配 X-Forwarded-* 头
□ systemd 管理 + Restart=always
□ 依赖锁定版本
□ 有 `/version` 与 `/health` 接口
□ 日志走 stdout（容器）或文件 + 轮转
```
