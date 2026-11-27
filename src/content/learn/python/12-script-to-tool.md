---
title: 把脚本变成能交付的工具
module: 进阶篇
summary: 结构、配置、日志、CLI、打包与 CI,以及五个"只有我能跑"的脚本通病。
minutes: 45
---

### 一个能交付的目录结构

```
tool/
  pyproject.toml
  src/tool/
    __init__.py
    cli.py          入口（参数解析）
    core.py         业务逻辑（可测试）
    config.py       配置读取
  tests/
  README.md
```

**"全部写在一个 500 行的 .py"** 无法测试、无法复用。

### 配置：三层优先级

```python
import os, json
from pathlib import Path

def load_config(path="config.json"):
    cfg = json.loads(Path(path).read_text(encoding="utf-8")) if Path(path).exists() else {}
    cfg.update({k: v for k, v in os.environ.items() if k.startswith("TOOL_")})
    return cfg
```

```
默认值 < 配置文件 < 环境变量 < 命令行参数
```

**"硬编码路径"** 是最常见的不可移植问题。

### 日志：分级 + 结构化

```python
import logging, json, sys

class JsonFormatter(logging.Formatter):
    def format(self, r):
        return json.dumps({"level": r.levelname, "msg": r.getMessage(), "logger": r.name})

h = logging.StreamHandler(sys.stderr)
h.setFormatter(JsonFormatter())
logging.basicConfig(level=logging.INFO, handlers=[h])
```

**"日志打到 stdout"** 会污染"脚本输出给管道"的数据（日志走 stderr）。

### CLI

```python
import argparse, sys

def main(argv=None):
    p = argparse.ArgumentParser(prog="tool")
    p.add_argument("--config", default="config.json")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    ...
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

**`main(argv)` 可注入参数** → 便于测试。

### 返回码约定

```
0 成功
1 一般错误
2 参数错误（argparse 默认）
>2 业务错误分类
```

**"永远 exit 0"** 会让 CI 认为失败也是成功。

### 打包

```toml
# pyproject.toml
[project]
name = "tool"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["requests>=2.31"]

[project.scripts]
tool = "tool.cli:main"
```

```bash
pip install -e .        # 开发
pipx install .          # 隔离环境安装
```

**"让对方 pip install -r requirements.txt 再手改路径"** 不叫交付。

### 测试（够用就行）

```python
def test_parse_ok():
    assert main(["--dry-run"]) == 0
```

```
① core 逻辑单测（不依赖网络/磁盘）
② CLI 冒烟测试
③ 一个"失败路径"的测试
```

### 五个"只有我能跑"

```
① 依赖没声明（我本地装了）
② 路径是绝对路径（/Users/me/...）
③ 需要手工先建目录/先跑另一脚本
④ 依赖我的 shell 环境变量
⑤ 没有 README（别人不知道从哪开始）
```

### CI 一条最小流水线

```yaml
- run: pip install -e .
- run: ruff check .
- run: pytest -q
```

**"CI 只跑 lint"** 没用；至少要有测试 + 一个真实入口的冒烟。

### 检查清单

```
□ 目录结构清晰（cli/core/config 分开）
□ 配置三层优先级
□ 日志走 stderr 且分级
□ argparse 提供 --help
□ 返回码有语义
□ pyproject 声明依赖与入口
□ 有 tests（含失败路径）
□ 有 README（安装/用法/示例）
□ 无绝对路径/无隐式前置步骤
□ CI 有 lint + test
```
