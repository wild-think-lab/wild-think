---
title: 文件读写与异常处理
module: 熟练篇
summary: with 打开文件、编码问题、JSON 与 CSV 读写，以及 try/except 的正确用法（而不是吞掉所有错误）。
minutes: 22
---

### 读写文本文件

```python
# 写
with open("notes.txt", "w", encoding="utf-8") as f:
    f.write("第一行\n")
    f.write("第二行\n")

# 读
with open("notes.txt", "r", encoding="utf-8") as f:
    for line in f:
        print(line.rstrip())    # rstrip 去掉行尾换行
```

**为什么必须用 `with`**：它保证文件用完后自动关闭，即使中途报错。手写 `f.open()` / `f.close()` 中途抛异常就会漏关，久了文件句柄耗尽，程序报 `Too many open files`。

### 四个模式

| 模式 | 含义 | 注意 |
| --- | --- | --- |
| `r` | 读，默认 | 文件不存在直接报错 |
| `w` | 写，**先清空** | 原内容全丢，最惨的一种误操作 |
| `a` | 追加 | 日志一般用这个 |
| `r+` | 读写 | 少用，容易搞混位置 |

想"不存在就创建、存在就报错"，用 `x` 模式。

### 编码：中文乱码只因为一个参数

```python
open("x.txt", "r", encoding="utf-8")
```

不写 `encoding`，Windows 下默认可能是 GBK，读 UTF-8 的中文就乱码。**所有文本文件操作都显式写 `encoding="utf-8"`**，一条规则省掉九成乱码问题。

读二进制（图片、压缩包）才用 `"rb"`，不需要 encoding。

### 路径：别用字符串拼

```python
from pathlib import Path

p = Path("~/lab/data")
p.exists(), p.is_dir()
for f in Path("/var/log").glob("*.log"):
    print(f.name, f.stat().st_size)

new = Path("~/lab/data").expanduser() / "out" / "a.txt"
new.parent.mkdir(parents=True, exist_ok=True)   # 父目录不存在就建
```

`Path` 解决两件事：跨平台分隔符（`/` 与 `\`）、以及"目录不存在先建"这个高频需求。

### 结构化数据：JSON 与 CSV

```python
import json

data = {"hosts": [{"name": "web1", "ip": "10.0.0.1"}]}
json.dump(data, open("cfg.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)

cfg = json.load(open("cfg.json", encoding="utf-8"))
print(cfg["hosts"][0]["ip"])
```

`ensure_ascii=False` 让中文正常显示成中文而不是 `\u4f60\u597d`。

CSV 用内置 `csv` 模块，不要用 `split(",")`——字段里带逗号就崩：

```python
import csv

with open("data.csv", newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        print(row["name"], row["size"])
```

### 异常：接住"可预期"的错误

```python
try:
    with open("cfg.json", encoding="utf-8") as f:
        cfg = json.load(f)
except FileNotFoundError:
    print("配置文件不存在，用默认值")
    cfg = {}
except json.JSONDecodeError as e:
    print(f"配置格式坏了：{e}")
    raise            # 这种是真问题，不能悄悄吞掉
```

三个原则：

1. **只捕获你知道怎么处理的错误**，别写 `except Exception: pass`——那会把 bug 藏起来，最后变成一个更难查的问题。
2. **`raise` 再抛出**，让调用方知道出事了。
3. 用 `finally` 做"无论如何都要执行"的清理，虽然 `with` 已经覆盖了文件场景。

### 自己验证

```python
from pathlib import Path

p = Path("~/lab/cfg.json").expanduser()
if not p.exists():
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('{"name": "demo"}', encoding="utf-8")

print(p.read_text(encoding="utf-8"))
print(p.stat().st_size)
```

`read_text` / `write_text` 是最省事的读写方式，小文件优先用它。

### 本章小结

- 一律 `with open(...)`，一律写 `encoding="utf-8"`。
- `w` 会清空文件，追加用 `a`。
- 路径用 `pathlib.Path`，别手拼字符串。
- 只捕获能处理的异常，其余 `raise`。

**下一章**：虚拟环境——为什么你的脚本在别人电脑上跑不起来。
