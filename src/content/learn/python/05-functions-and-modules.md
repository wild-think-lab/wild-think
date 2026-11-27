---
title: 函数与模块：把代码拆开
module: 基础篇
summary: 定义函数、参数与返回值、作用域，以及 finally 那句"库是怎么 import 进来的"。
minutes: 20
---

### 为什么必须拆函数

一段代码只跑一次，怎么写都行。要跑第二次、要改、要交给别人看的时候，不拆就是灾难。

**函数解决三件事**：复用、名字（让人知道这段在干什么）、隔离（变量不外泄）。

```python
def total_price(price, qty, discount=1.0):
    """算总价，discount 不传就是不打折"""
    return price * qty * discount


print(total_price(19.9, 3))            # 59.7
print(total_price(19.9, 3, 0.8))       # 47.76
```

四要素：`def` + 函数名 + 参数表 + `return`。没有 `return` 时函数返回 `None`。

### 参数：位置、默认、关键字

```python
def connect(host, port=22, user="root", timeout=10):
    ...

connect("10.0.0.1")                       # 用默认端口和用户
connect("10.0.0.1", port=2222)
connect(user="dev", host="10.0.0.2")      # 关键字参数，顺序不重要
```

默认参数别写可变对象，这是经典陷阱：

```python
def bad(items=[]):        # 这个 [] 只创建一次，会跨调用累积
    items.append(1)
    return items

def good(items=None):
    items = items or []
    return items
```

### 返回值：一个还是多个

```python
def parse(line):
    name, _, size = line.partition(":")
    return name.strip(), int(size)     # 实际返回的是一个元组

user, size = parse("nginx: 1024")
```

返回值可以是任意类型，包括列表、字典、另一个函数。

### 作用域：变量活在哪

```python
count = 0            # 全局

def inc():
    global count     # 声明要改全局的
    count += 1

def local():
    count = 99       # 这是新的局部变量，不影响外面
```

规则是：函数内部赋值就产生局部变量；要改全局必须 `global`。**少用 global**，把值当参数传、当返回值收，逻辑更清楚。

### 模块：把函数搬到别的文件

`tools.py`：

```python
def human_size(n):
    for unit in ["B", "KB", "MB", "GB"]:
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"
```

`main.py` 同目录：

```python
from tools import human_size
# 或者 import tools 然后用 tools.human_size(...)

print(human_size(1536000))    # 1.5MB
```

`import` 的本质：找到 `tools.py`、执行它、把里面定义的名字挂到一个对象上。所以：

- 同目录的文件能直接 import（当前目录在搜索路径里）。
- 找不到时先看**运行时所在目录**，而不是文件所在目录——`python3 sub/main.py` 和 `cd sub && python3 main.py` 结果可能不同。
- 标准库（`os`、`sys`、`json`、`re`）不用装，第三方库（`requests`、`pandas`）要先 `pip install`。

### 自己验证

在 `~/lab` 下建两个文件，按上面写法跑一次：

```bash
python3 main.py
# 1.5MB
```

然后故意把 `tools.py` 改名，看报错长什么样：

```
ModuleNotFoundError: No module named 'tools'
```

以后看到这句，就知道是"文件不在搜索路径里"或"名字打错了"，不是代码写错。

### 本章小结

- 函数 = 名字 + 参数 + 返回值，用 `return` 交结果。
- 默认参数别用可变对象。
- `global` 少用，值靠参数传递。
- `import` 是"找文件并执行"，找不到先查运行目录和拼写。

**下一章**：列表和字典——真实数据长什么样。
