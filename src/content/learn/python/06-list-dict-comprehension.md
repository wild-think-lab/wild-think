---
title: 列表、字典与推导式
module: 基础篇
summary: 两种最常用的数据结构，加"一行写完循环"的推导式，以及什么时候不该用推导式。
minutes: 22
---

### 列表：有序、可变、什么都能装

```python
files = ["a.log", "b.log", "c.txt"]
files.append("d.log")        # 末尾加
files.insert(0, "x.log")     # 指定位置插
files.remove("b.log")        # 按值删（有多个只删第一个）
last = files.pop()           # 弹出末尾
print(len(files), files[0], files[-1])
print("a.log" in files)      # 成员判断
```

切片是列表最好用的能力：

```python
nums = [10, 20, 30, 40, 50]
nums[1:3]      # [20, 30]   左闭右开
nums[:2]       # 前两个
nums[2:]       # 从第 3 个到末尾
nums[::2]      # 隔一个取一个
nums[::-1]     # 反转
```

### 排序与统计

```python
nums.sort()                            # 原地升序
nums.sort(reverse=True)                # 降序
sorted(nums)                           # 返回新列表，不改原列表
sorted(files, key=len)                 # 按长度排
max(nums), min(nums), sum(nums)
```

`sort` 改原对象、`sorted` 出新对象——这个区别在"处理完数据还要用原数据"时很关键。

### 字典：键值对，按名字查

```python
server = {
    "host": "10.0.0.1",
    "port": 22,
    "user": "root",
}
print(server["host"])          # 键不存在会 KeyError
print(server.get("pwd", ""))   # 安全取值，没这个键给默认值
server["port"] = 2222          # 改
server["tag"] = "prod"         # 加
del server["tag"]
server.keys(), server.values(), server.items()
```

遍历字典：

```python
for k, v in server.items():
    print(f"{k} = {v}")
```

`get()` 比 `[]` 更安全，读外部数据（配置、JSON）时一律用 `get`。

### 嵌套：真实数据就长这样

```python
hosts = [
    {"name": "web1", "ip": "10.0.0.1", "role": "web"},
    {"name": "db1",  "ip": "10.0.0.5", "role": "db"},
]

for h in hosts:
    if h["role"] == "web":
        print(h["name"], h["ip"])
```

大多数"处理数据"的脚本，本质是在嵌套结构里筛和改。

### 推导式：一行完成"遍历 + 筛选 + 变换"

```python
ips = [h["ip"] for h in hosts]
web = [h for h in hosts if h["role"] == "web"]
names = [h["name"].upper() for h in hosts]

# 字典推导式
port_map = {h["name"]: h["ip"] for h in hosts}
```

等价写法是：

```python
ips = []
for h in hosts:
    ips.append(h["ip"])
```

推导式更快、更短，但**只在"简单筛选/变换"时用**。嵌套两层以上、带复杂条件时，老老实实写循环，可读性优先。

### 常见坑

| 坑 | 现象 | 说明 |
| --- | --- | --- |
| 遍历时删除元素 | 漏掉元素 | 用新列表 `[x for x in lst if ...]` |
| 字典用不存在的键 | `KeyError` | 用 `get` |
| 列表赋值 `b = a` | 改 b 结果 a 也变了 | 这是引用；要复制用 `a.copy()` 或 `list(a)` |
| `[[]] * 3` | 三个子列表其实是同一个 | 用 `[[] for _ in range(3)]` |

引用这个坑最隐蔽：`b = a` 不是复制，只是两个名字指向同一块数据。

### 练习：从日志里数 IP

```python
logs = [
    "10.0.0.1 GET /index 200",
    "10.0.0.2 GET /login 404",
    "10.0.0.1 POST /api 500",
]

from collections import Counter
ips = [line.split()[0] for line in logs]
print(Counter(ips).most_common())
```

### 本章小结

- 列表有序可改，字典按键取值；`get` 比 `[]` 安全。
- 切片左闭右开，`[::-1]` 反转。
- `b = a` 是引用不是复制。
- 推导式适合简单筛选，复杂逻辑用循环。

**下一章**：读写文件、处理报错——脚本真正开始干活的地方。
