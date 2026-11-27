---
title: 测试与质量：pytest 与 CI 门禁
module: 熟练篇
summary: pytest 的固件与参数化、覆盖率的意义、在 CI 里跑什么、五个"测试写了但没用"的原因。
minutes: 45
---

### 最小可用的测试

```python
# test_calc.py
import pytest
from calc import divide

def test_divide_ok():
    assert divide(10, 2) == 5

def test_divide_zero():
    with pytest.raises(ZeroDivisionError):
        divide(1, 0)
```

```bash
pip install pytest
pytest -q
```

### 参数化（别复制粘贴用例）

```python
@pytest.mark.parametrize("a,b,expect", [
    (10, 2, 5), (0, 3, 0), (-9, 3, -3),
])
def test_divide(a, b, expect):
    assert divide(a, b) == expect
```

### 固件（fixture）

```python
@pytest.fixture
def client():
    c = make_client()
    yield c
    c.close()

def test_api(client):
    assert client.get("/health").status_code == 200
```

**要点**：`yield` 之后是清理；scope 控制创建频率（`session`/`module`/`function`）。

### 覆盖率

```bash
pytest --cov=app --cov-report=term-missing
```

**判据**：

```
① 覆盖率是"发现盲区"的工具，不是 KPI
② 强推 90% → 写大量无断言测试
③ 关注"关键模块"的行覆盖率
```

**"覆盖率 95% 但线上照样挂"** → 覆盖率不衡量断言质量。

### CI 里跑什么

```yaml
# 简化版
steps:
  - run: pip install -r requirements-dev.txt
  - run: ruff check .
  - run: mypy app            # 可选
  - run: pytest -q --cov=app --cov-fail-under=70
```

```
顺序：格式/静态检查（快）→ 类型 → 单元测试 → 集成测试
```

**"CI 只跑 build"** → 语法错都要上线才发现。

### 测试分层

```
① 单元：快、多、无外部依赖
② 集成：连真实 DB/MQ（用容器）
③ 端到端：少而关键
```

**判据**：单元测试应在秒级完成；慢的是集成。

### 五个"测试写了但没用"

**① 没有断言**

```
调用一下就算测试，永远绿
```

**② 依赖外部环境**

```
本地能过，CI 挂（或反过来）
```

**③ 测试互相影响**

```
共享全局状态 → 顺序一变就失败
```

**④ 只测 happy path**

```
异常/边界没覆盖
```

**⑤ 慢到没人跑**

```
一次 20 分钟 → 开发者跳过
```

### 外部依赖怎么处理

```
① 单测用 mock/替身
② 集成用 testcontainers 起真 DB
③ 不要连测试环境的共享库（互相污染）
```

### 检查清单

```
□ 有 pytest 与基本结构
□ 关键逻辑有参数化用例
□ 固件负责创建与清理
□ 有异常/边界用例
□ 覆盖率用于发现盲区（不当 KPI）
□ CI 先跑快的检查
□ 单元测试无外部依赖
□ 集成测试用独立资源
□ 测试无相互干扰
□ 慢测试有分层/标记
```
