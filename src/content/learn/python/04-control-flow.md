---
title: 流程控制：if、for、while
module: 入门篇
summary: 缩进即语法，条件判断与两类循环，配"打印九九乘法表"这种能立刻看到结果的练习。
minutes: 20
---

### 缩进就是语法

Python 用**缩进**表示"属于上一行的内容"，没有大括号。缩进错了不是排版问题，是语法错误或者逻辑完全变了。

```python
if True:
    print("在 if 里面")     # 4 个空格
print("在外面")
```

同一个块里必须用一致的空格数（统一 4 个空格，别混 Tab）。

### if：做选择

```python
score = 76

if score >= 90:
    level = "A"
elif score >= 75:
    level = "B"
elif score >= 60:
    level = "C"
else:
    level = "D"

print(f"{score} 分，等级 {level}")
```

条件可以组合：

```python
if score >= 60 and score < 90:
    print("及格但不算优秀")
if user == "admin" or user == "root":
    print("有管理权限")
if not ok:
    print("失败")
```

`and` / `or` / `not` 就是"且 / 或 / 非"。Python 会短路求值：`a and b` 中 `a` 为假就不再判断 `b`，所以 `if x and x.foo` 这种写法是安全的。

### for：遍历

```python
for i in range(5):        # 0 1 2 3 4
    print(i)

for f in ["a.txt", "b.txt"]:
    print(f"处理 {f}")

for i, name in enumerate(["a", "b"]):
    print(i, name)        # 0 a / 1 b
```

`range(5)` 是 `0..4`，**不含 5**——这一点几乎每个人都会错一次。

### while：条件满足就一直做

```python
n = 0
while n < 3:
    print(n)
    n += 1        # 忘了这行就是死循环
```

死循环用 `Ctrl+C` 停。写 `while` 时先想清楚"哪一步会让条件变假"。

### break、continue、else

```python
for port in range(80, 90):
    if port == 85:
        continue      # 跳过这一个，继续下一个
    if port == 88:
        break         # 整个循环结束
    print(port)
```

`for...else` 是一个反直觉但有用的写法：循环正常跑完（没被 break）才执行 else，常用来判断"循环里有没有找到"：

```python
for f in files:
    if f.endswith(".log"):
        print("找到日志", f)
        break
else:
    print("没有日志文件")
```

### 练习：九九乘法表

```python
for i in range(1, 10):
    row = ""
    for j in range(1, i + 1):
        row += f"{j}x{i}={i*j}  "
    print(row)
```

跑起来能看到三角形状的表。写不出来就先做更小的：只打印 1 到 3 的乘法，跑通了再扩。

### 三个必踩的坑

| 坑 | 现象 | 原因 |
| --- | --- | --- |
| `range(1, 10)` 想打印到 10 | 少一行 | 右边界不包含 |
| 循环里改列表又遍历它 | 结果莫名其妙 | 一边遍历一边改，换成遍历副本 `for x in list(lst)` |
| 缩进混用 Tab 和空格 | `IndentationError` | 编辑器设成"空格替代 Tab" |

### 本章小结

- 缩进是语法，统一 4 空格。
- `if / elif / else` 做选择，条件用 `and` `or` `not` 组合。
- `range(n)` 不含 n；`while` 必须能让条件变假。
- `break` 结束整个循环，`continue` 跳过本次。

**下一章**：把代码拆成函数，才能复用。
