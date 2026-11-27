---
title: 面向对象基础：把数据和行为放进一个盒子
module: 熟练篇
summary: 类与实例、属性与方法、继承与组合的取舍，以及三个"写 OOP 就过度设计"的信号。
minutes: 40
---

### 最小模型

```python
class Account:
    def __init__(self, owner: str, balance: int = 0):
        self.owner = owner
        self._balance = balance     # 下划线 = 内部使用

    @property
    def balance(self) -> int:
        return self._balance

    def deposit(self, amount: int) -> None:
        if amount <= 0:
            raise ValueError("amount must be positive")
        self._balance += amount

    def withdraw(self, amount: int) -> None:
        if amount <= 0:
            raise ValueError("amount must be positive")
        if amount > self._balance:
            raise ValueError("insufficient balance")
        self._balance -= amount
```

**要点**：

```
① __init__ 里建立"不变量"（余额不能为负）
② 用方法而不是"外部直接改字段"
③ 校验在"入口"完成（不靠调用方自觉）
```

### 属性 vs 方法

```python
class Order:
    def __init__(self, items): self.items = items

    @property
    def total(self):                 # 看起来像属性，实际是计算
        return sum(i.price * i.qty for i in self.items)
```

**经验**：

```
零成本的取值 → 属性
可能耗时 / 有副作用 / 需要参数 → 方法
```

### 继承 vs 组合

```python
# 组合（更常用）
class Service:
    def __init__(self, repo, cache):
        self.repo, self.cache = repo, cache

# 继承（用于"确实是一种"）
class HttpRepo(BaseRepo):
    def fetch(self, key): ...
```

**判据**：

```
"is-a" → 继承；"has-a" / "uses" → 组合
```

**"为了少写几行而继承"** 会让改动变得困难。

### 三个"过度设计"的信号

**① 为每个字段配 getter/setter**

```
Python 里没必要（用属性即可）
```

**② 抽象层比实现还多**

```
Interface → Abstract → Impl → ImplImpl
（读代码的人要跳四层）
```

**③ 一个类 300 行、20 个方法**

```
说明它承担了多个职责 → 该拆
```

### 数据类（省掉样板代码）

```python
from dataclasses import dataclass, field

@dataclass
class Item:
    sku: str
    price: int
    qty: int = 1
    tags: list[str] = field(default_factory=list)
```

**判据**：

```
"主要装数据" → dataclass
"主要做行为" → 普通类
```

### 魔术方法（少量就够）

```python
class Money:
    def __init__(self, cents: int): self.cents = cents
    def __add__(self, other): return Money(self.cents + other.cents)
    def __repr__(self): return f"Money({self.cents})"
```

**"给所有类都写一堆魔术方法"** 是负担，只在语义明确时加。

### 一个"能读"的结构

```
models/       数据与不变量（无 IO）
services/     业务流程（编排）
repos/        数据访问（IO）
api/          入口（参数校验、错误转换）
```

**"业务逻辑写在视图函数里"** → 无法复用、无法测试。

### 检查清单

```
□ __init__ 建立不变量
□ 校验在入口
□ 优先组合而非继承
□ 用 dataclass 装数据
□ 没有无意义的 getter/setter
□ 类职责单一（不超过 ~200 行）
□ 业务逻辑不在视图层
□ 有类型注解
□ 有单元测试覆盖"不变量"
```
