---
title: 变量与数据类型：程序里装东西的盒子
module: 入门篇
summary: 字符串、数字、布尔、None 四类基础类型，加上"为什么 1 + '1' 会报错"这类必踩的坑。
minutes: 18
---

### 变量就是贴了名字的盒子

```python
age = 25
name = "王小明"
print(name, age)
```

Python 里不需要声明类型，赋值时就确定了。想看它到底是什么类型：

```python
type(age)     # <class 'int'>
type(name)    # <class 'str'>
```

### 四类基础类型

| 类型 | 写法 | 用途 | 常见坑 |
| --- | --- | --- | --- |
| 字符串 `str` | `"abc"` `'abc'` | 文字、路径、配置 | 数字和字符串不能直接相加 |
| 整数 / 浮点 `int` `float` | `42` `3.14` | 计数、计算 | `0.1 + 0.2 != 0.3`（浮点误差） |
| 布尔 `bool` | `True` `False` | 判断结果 | 字符串 `"False"` 是真值 |
| 空值 `None` | `None` | "还没有值" | 对 `None` 做运算直接报错 |

### 字符串：最常用的类型

```python
s = "hello world"
print(len(s))            # 11
print(s.upper())         # HELLO WORLD
print(s.split())         # ['hello', 'world']
print(s.replace("world", "python"))
print(s[0], s[-1])       # h d，-1 是最后一个
print(s[:5])             # hello，切片
```

**f-string** 是拼字符串的标准做法，比 `+` 拼接和 `%` 格式清楚得多：

```python
name = "小明"
count = 3
print(f"{name} 有 {count} 个任务，明天还剩 {count - 1} 个")
```

### 数字

```python
a = 7
b = 2
print(a / b)     # 3.5   真除法
print(a // b)    # 3     整除
print(a % b)     # 1     取余
print(a ** b)    # 49    幂
```

`/` 永远返回浮点数，这一点和 C 不一样。想取整用 `//`。

涉及钱的场景不要用 `float`，用 `decimal.Decimal` 或按"分"存整数。

### 类型转换与那个经典报错

```python
age = "25"            # 这是字符串
age + 1               # TypeError: can only concatenate str (not "int") to str
int(age) + 1          # 26，先转成整数
str(100) + "%"        # "100%"
```

用户输入、文件读出来的内容**全是字符串**，想算数必须先转。这是新手第一个必踩的坑。

反向的坑：`bool("False")` 是 `True`，因为非空字符串都算真。想判断字符串内容要写 `s == "False"`。

### 常见运算符

```python
a == b     # 相等（判断用两个等号）
a != b     # 不等
a > b
x = 1      # 赋值用一个等号
```

把 `==` 写成 `=` 是语法错误或逻辑错误，`if x = 1` 会直接报错，这点 Python 帮了你。

### 自己验证

```python
price = "19.9"
qty = 3
total = float(price) * qty
print(f"总价 {total:.2f} 元")     # .2f 保留两位小数
```

### 本章小结

- 变量不需要声明类型，`type()` 随时查。
- 输入和文件读出来都是字符串，想算数先 `int()` / `float()`。
- 拼字符串用 f-string，不要用 `+`。
- `/` 是浮点除法，`//` 才是整除。

**下一章**：让程序会"做判断"和"重复做"。
