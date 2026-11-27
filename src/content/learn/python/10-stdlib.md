---
title: 常用标准库：别再手写轮子
module: 熟练篇
summary: os/pathlib、json、datetime、logging、argparse、subprocess 的常用姿势与五个"看着能用其实有坑"的写法。
minutes: 45
---

### 路径：优先 pathlib

```python
from pathlib import Path

p = Path("/var/log/app")
for f in p.glob("*.log"):
    print(f.name, f.stat().st_size)

out = Path("out") / "2026" / "11"
out.mkdir(parents=True, exist_ok=True)
```

**"字符串拼路径"** → 跨平台容易出错（`os.path.join` 也行，但 pathlib 更清晰）。

### JSON

```python
import json

with open("cfg.json", encoding="utf-8") as f:
    cfg = json.load(f)

json.dump(cfg, open("out.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
```

**坑**：

```
① 不指定 encoding → Windows 下中文乱码
② ensure_ascii=True → 中文变 \uXXXX
③ 读一个不存在的文件 → FileNotFoundError（要 try）
```

### 时间：datetime 而不是 time

```python
from datetime import datetime, timedelta, timezone

now = datetime.now(timezone.utc)
local = now.astimezone()
ts = int(now.timestamp())
fmt = now.strftime("%Y-%m-%d %H:%M:%S")
parsed = datetime.strptime("2026-11-27", "%Y-%m-%d")
yesterday = now - timedelta(days=1)
```

**"混用 naive 与 aware"** 会导致"差 8 小时"这类问题。

**规则**：

```
存储用 UTC（aware）
展示时再转本地
```

### logging（别用 print）

```python
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("app")

log.info("started", extra={"job": "backup"})
log.exception("failed")           # 在 except 里用，带堆栈
```

**"print 调试"** 在后台运行时无法分级/无法收集。

### argparse（脚本要能 --help）

```python
import argparse

p = argparse.ArgumentParser(description="sync files")
p.add_argument("src")
p.add_argument("--dest", required=True)
p.add_argument("--dry-run", action="store_true")
args = p.parse_args()
```

**"位置参数 + 硬编码"** 让脚本无法复用。

### subprocess（.run 优先）

```python
import subprocess

r = subprocess.run(["ls", "-l"], capture_output=True, text=True, timeout=10)
if r.returncode != 0:
    raise RuntimeError(r.stderr)
```

**五个坑**：

```
① shell=True + 拼接用户输入 → 命令注入
② 不设 timeout → 卡死
③ 不检查 returncode → 静默失败
④ 用 Popen 却不读管道 → 缓冲区满卡住
⑤ 不传 text=True → bytes 处理麻烦
```

### 五个"看着能用"的写法

**① `open()` 不 close**

```
用 with（上下文管理器）
```

**② `except:` 裸捕获**

```
会吞掉 KeyboardInterrupt → 必须 except Exception
```

**③ 用 `os.system`**

```
拿不到输出、没有返回码语义
```

**④ 遍历时改列表**

```
for x in lst: lst.remove(x) → 漏元素
（用 lst[:] 或列表推导）
```

**⑤ 用 `datetime.now()` 存数据库**

```
naive 时间 → 跨时区错乱
```

### 检查清单

```
□ 路径用 pathlib
□ JSON 指定 encoding 与 ensure_ascii
□ 时间用 aware UTC
□ 日志用 logging（分级 + 格式）
□ 脚本用 argparse
□ subprocess 用 run + timeout + 检查返回码
□ 不用 shell=True 拼用户输入
□ 用 with 管理资源
□ 不用裸 except
```
