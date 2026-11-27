---
title: 用 Python 调接口：requests 的正确姿势
module: 进阶篇
summary: 超时与重试、连接复用、错误处理、分页与批量，以及五个"脚本卡死"的原因。
minutes: 45
---

### 最小可用

```python
import requests

r = requests.get("https://api.example.com/users",
                 params={"page": 1},
                 headers={"Authorization": f"Bearer {token}"},
                 timeout=(3, 10))       # (连接, 读取)
r.raise_for_status()
data = r.json()
```

**`timeout` 必设**，否则可能永久挂住（默认无超时）。

### 重试（只重试"可重试"的）

```python
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

s = requests.Session()
s.mount("https://", HTTPAdapter(max_retries=Retry(
    total=3, backoff_factor=0.5,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=["GET", "HEAD"],
)))
```

**"给 POST 加重试"** 可能重复下单（除非接口幂等）。

### 连接复用

```python
s = requests.Session()      # 复用 TCP + 连接池
for item in items:
    s.get(url)
```

**"每次都 requests.get"** → 每次新建连接（TLS 握手成本高）。

### 错误处理的三种情况

```python
try:
    r = s.get(url, timeout=(3, 10))
    r.raise_for_status()
except requests.Timeout:
    log.warning("timeout %s", url)
except requests.HTTPError as e:
    log.error("http %s: %s", e.response.status_code, e.response.text[:200])
except requests.RequestException as e:
    log.error("request failed: %s", e)
```

**"只 except Exception"** 会掩盖"该重试"和"该报警"的区别。

### 分页抓取

```python
page = 1
while True:
    r = s.get(url, params={"page": page, "size": 100}, timeout=10)
    r.raise_for_status()
    items = r.json().get("items", [])
    if not items:
        break
    yield from items
    page += 1
```

**"while True 不限次数"** → 接口异常时会死循环（加最大页数）。

### 五个"脚本卡死"

**① 没设 timeout**

```
DNS 慢/服务端不响应 → 永久阻塞
```

**② 大文件一次性读进内存**

```python
with s.get(url, stream=True, timeout=30) as r:
    for chunk in r.iter_content(8192):
        f.write(chunk)
```

**③ 连接池太小 + 并发太高**

```
pool_maxsize 默认 10 → 高并发排队
```

**④ 重试把故障放大**

```
服务端 500 时重试 3 次 → 流量 ×4
```

**⑤ 没关 Session**

```
脚本长期运行 → 连接与文件句柄泄漏
```

### 并发抓取（别用线程开 1000）

```python
from concurrent.futures import ThreadPoolExecutor

with ThreadPoolExecutor(max_workers=8) as ex:
    results = list(ex.map(fetch, urls))
```

**判据**：

```
IO 密集 → 线程/协程（8–32 并发足够）
CPU 密集 → 多进程
```

### 检查清单

```
□ 每个请求都有 timeout
□ 只对幂等请求重试
□ 用 Session 复用连接
□ 分别处理 Timeout / HTTPError / 其他
□ 分页有上限
□ 大文件用 stream
□ 并发数受控
□ 有关闭 Session/连接池
□ 有请求日志（URL/状态/耗时）
□ 敏感 token 不写进日志
```
