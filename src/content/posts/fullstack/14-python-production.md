---
title: Python 服务的生产化：从 "python app.py" 到能扛流量的服务
description: Gunicorn/Uvicorn 的选择、worker 数、优雅重启、依赖锁定、日志与健康检查，以及五个必改项。
date: 2026-11-27
tags: [Python, 部署, 后端]
---

### 别用 `python app.py` 上生产

```
开发服务器（Flask dev server / runserver）：
① 单进程单线程
② 无超时控制
③ 无优雅关闭
④ 有调试器暴露风险
```

**它只适合本地开发**。

### 同步 vs 异步

```
同步框架（Flask、Django WSGI）→ Gunicorn（sync worker）
异步框架（FastAPI、Starlette）→ Uvicorn（ASGI worker）
```

**Gunicorn 也能跑 ASGI**（`-k uvicorn.workers.UvicornWorker`），这是最常用的组合：

```bash
gunicorn app.main:app \
  -k uvicorn.workers.UvicornWorker \
  -w 4 \
  -b 0.0.0.0:8000 \
  --timeout 60 \
  --graceful-timeout 30 \
  --access-logfile - \
  --error-logfile -
```

### worker 数怎么定

```
同步 worker：workers = 2 × CPU 核数 + 1
异步 worker：workers ≈ CPU 核数（每个 worker 内部并发处理）
```

**为什么同步是 `2×CPU+1`**：

```
一个 worker 在等 IO 时，另一个可以用 CPU
（来自 Gunicorn 官方文档的经验公式）
```

**但内存是硬约束**：

```
每个 worker 一个 Python 进程（各自 import 一遍库）
Django 项目单 worker 常 100–200MB
→ 16G 机器最多 8 个 worker 左右
```

**异步框架的优势**：

```
一个 worker 能同时处理成百上千个协程
→ 同样的内存，更高并发
```

**代价**：同步代码里的阻塞调用会卡住整个事件循环（要特别小心）。

### 五个必改项

**① 优雅重启**

```bash
# Gunicorn：向 master 发 HUP，重启 worker（不断连接）
kill -HUP $(cat /run/gunicorn.pid)

# Uvicorn 独立运行
kill -TERM $(cat /run/uvicorn.pid)   # 支持优雅关闭
```

**`graceful-timeout`**：给正在处理的请求多久时间去完成（默认 30s）。

**② 超时**

```bash
--timeout 60          # worker 处理超过 60s 会被 kill（防挂死）
--graceful-timeout 30
```

**`--timeout` 太长会导致"卡住的 worker 长期占资源"**；太短会误杀慢接口。

**③ 依赖锁定**

```bash
# 用 pip-tools 或 uv
pip-compile requirements.in -o requirements.txt
# 或
uv pip compile requirements.in -o requirements.txt
```

**为什么必须锁定**：

```
requirements.txt 里写 requests>=2.0 → 每次部署可能装到不同版本
→ 昨天好好的，今天崩了
```

**锁到 `==` 且带 hash**：

```bash
pip install --require-hashes -r requirements.txt
```

**④ 日志**

```python
import logging, sys

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s %(message)s',
    stream=sys.stdout,     # 容器里写 stdout，由运行时收集
)
```

**规则**：

```
① 写 stdout/stderr（不要自己写文件，容器场景会丢）
② 结构化（JSON 更好，便于检索）
③ 带 request_id（串联一次请求的所有日志）
```

**⑤ 健康检查**

```python
@app.get("/healthz")
def healthz():
    return {"status": "ok"}

@app.get("/readyz")
def readyz():
    # 检查依赖（DB / Redis）
    try:
        db.execute("SELECT 1")
        return {"status": "ready"}
    except Exception:
        return JSONResponse({"status": "not ready"}, status_code=503)
```

**`liveness` 与 `readiness` 要分开**：

```
liveness ：进程活着吗（挂了就重启）
readiness：能接流量吗（依赖故障时摘除，但不重启）
```

**混在一起会导致"数据库短暂抖动 → 全部 Pod 被杀重启"**。

### 容器化要点

```dockerfile
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd -m app && chown -R app /app
USER app

EXPOSE 8000
CMD ["gunicorn", "app.main:app", "-k", "uvicorn.workers.UvicornWorker", \
     "-w", "4", "-b", "0.0.0.0:8000", "--timeout", "60", \
     "--access-logfile", "-", "--error-logfile", "-"]
```

**关键三行**：

```
PYTHONUNBUFFERED=1   → 日志实时输出（否则容器里看不到日志）
非 root 用户         → 安全
--no-cache-dir       → 镜像更小
```

### 一个常见性能坑：数据库连接池

```python
# 错的：每个请求新建连接
def get_user(uid):
    conn = pymysql.connect(...)
    ...

# 对的：连接池
from sqlalchemy import create_engine
engine = create_engine(
    "mysql+pymysql://...",
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,      # 取连接前 ping 一下（防死连接）
    pool_recycle=3600,       # 1 小时回收（防被服务端断开）
)
```

**`pool_pre_ping` + `pool_recycle` 是必配**，否则会遇到"隔夜第一个请求超时"。

### 内存与 GC

```
Python 的内存不会及时还给 OS（pymalloc 机制）
→ RSS 只增不减是正常现象
```

**真正的内存泄漏识别**：

```python
# 用 tracemalloc 或 memray 定位
import tracemalloc
tracemalloc.start()
# ... 跑一段时间
snapshot = tracemalloc.take_snapshot()
for stat in snapshot.statistics('lineno')[:10]:
    print(stat)
```

**处理**：

```
① 确认是"缓存增长"还是"真泄漏"（前者可设上限）
② Gunicorn 加 --max-requests 1000 --max-requests-jitter 100（定期重启 worker）
③ 大对象用完置 None，或分页处理
```

**`--max-requests` 是"止损"而非修复**，但生产上很实用。

### 一个可直接用的 systemd unit

```ini
[Unit]
Description=app
After=network.target

[Service]
Type=notify
User=app
WorkingDirectory=/opt/app
Environment="PATH=/opt/app/.venv/bin"
ExecStart=/opt/app/.venv/bin/gunicorn app.main:app \
    -k uvicorn.workers.UvicornWorker -w 4 -b 127.0.0.1:8000 \
    --timeout 60 --graceful-timeout 30
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

**`Type=notify`** 需要 Gunicorn 支持 sd_notify（较新版本支持），否则用 `Type=simple`。

### 检查清单

```
□ 不用开发服务器上生产
□ 同步用 Gunicorn、异步用 Uvicorn
□ worker 数按 CPU + 内存双重约束
□ --timeout 与 --graceful-timeout 设好
□ 优雅重启（HUP / TERM）
□ 依赖锁到 == 且可带 hash
□ 日志写 stdout + 带 request_id
□ liveness/readiness 分开
□ 连接池配 pre_ping + recycle
□ 容器里 PYTHONUNBUFFERED=1 + 非 root
□ 有内存泄漏定位手段（tracemalloc/memray）
□ --max-requests 兜底
□ systemd unit 完整（Restart + LimitNOFILE）
```
