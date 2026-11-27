---
title: Python 环境与依赖：从"我这能跑"到"谁都能跑"
description: 三个 venv、两个 Python 版本、一份没锁版本的 requirements.txt，是 Python 项目最常见的现场。把解释器、环境、依赖锁三层分开管，问题会少一半。
date: 2026-11-20
tags: [Python, 工程化, 依赖管理, 全栈]
---

"在我机器上是好的"这句话，在 Python 项目里有非常具体的成因：解释器版本不同、虚拟环境混用、依赖没锁。三层各有解法，混在一起治就会反复。

## 一、三层结构

```text
解释器版本     pyenv / uv python install / 系统包管理器
    ↓
项目环境       venv / virtualenv（每个项目一个，绝不共用）
    ↓
依赖锁         pyproject.toml + lock 文件（uv.lock / poetry.lock / requirements.txt@hash）
```

只要有一层失控，另两层做得再好也会塌。

## 二、虚拟环境：别用 `python -m venv` 之外的偏方

```bash
# 标准做法
python3.12 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
python -m pip install -U pip

# 更快的选择（Rust 实现，装包快一个数量级）
uv venv --python 3.12 .venv
uv pip install -r requirements.txt
```

判断"当前到底在哪个环境"：

```bash
which python          # Linux/macOS
where python          # Windows
python -c "import sys; print(sys.prefix, sys.version)"
python -m site        # 看 site-packages 路径，最可靠
```

找不到 `pip install` 装到哪了，跑 `python -m site` 比 `pip -V` 准，因为后者可能被 alias 或 shell 包装过。

三个反模式：

1. `sudo pip install` —— 装进系统解释器，迟早和发行版包管理器打架；
2. 全局 `PYTHONPATH` —— 让"哪个版本生效"变成玄学；
3. 把 `.venv` 提交进仓库 —— 换平台即失效，且体积巨大。

## 三、依赖锁定：从"能装"到"装出一样的东西"

```toml
# pyproject.toml（PEP 621）
[project]
name = "demo"
requires-python = ">=3.11,<3.13"
dependencies = [
  "fastapi>=0.110,<0.120",
  "sqlalchemy[asyncio]>=2.0",
]

[project.optional-dependencies]
dev = ["pytest>=8", "ruff>=0.4", "mypy>=1.9"]
```

```bash
uv lock                       # 生成 uv.lock，含完整依赖树与哈希
uv sync                       # 按 lock 精确安装
uv sync --extra dev           # 装开发依赖
```

不要用 `pip freeze > requirements.txt` 作为唯一锁：它只记录**当前平台**能装的包，且不带哈希，跨平台重建时会拿到不同的间接依赖。

要兼容旧流程时，让 lock 生成带哈希的 requirements：

```bash
uv export --format requirements-txt --hash > requirements.txt
pip install --require-hashes -r requirements.txt
```

## 四、依赖冲突的定位方法

```bash
# 谁依赖了谁、为什么装这个版本
uv tree                              # 依赖树
uv pip show requests                 # 单个包来源
pip check                            # 已装环境的冲突检查
```

典型报错 `Cannot install X and Y because these package versions have conflicting dependencies` 时，按顺序做：

1. `uv tree` 找出共同的上游依赖；
2. 放宽上游的版本约束而不是直接 `--no-deps` 硬装；
3. 确实需要两个版本时，用 `uv pip install --target ./vendor` 隔离，或拆服务。

`--no-deps` 不解决冲突，只是把冲突推迟到运行时 `ImportError`。

## 五、C 扩展与平台差异

`psycopg2`、`lxml`、`numpy` 这类包在不同平台表现不同，原因通常是缺编译依赖或轮子版本不匹配。

- 优先用 `manylinux` 轮子：`pip install --only-binary=:all: <pkg>`，装不上说明该平台无轮子；
- 需要编译时，构建环境要有 `gcc`、`python3-dev`、`libpq-dev` 等（Debian 系）；
- macOS Apple Silicon 与 x86 的 wheel 不同，CI 要用对应架构的 runner。

容器化的正确姿势：

```dockerfile
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . .
CMD ["uv", "run", "python", "-m", "app"]
```

`--frozen` 保证**不使用**任何重新解析，只用 lock；`--no-dev` 避免把测试依赖带进镜像。

## 六、面试与协作里最常问的一句

"你怎么保证别人装出来的环境和你一样？"标准回答三段：

1. **解释器**用 `requires-python` + CI 矩阵锁住版本范围；
2. **环境**用 venv/uv 隔离，容器里不用 venv（镜像本身就是隔离）；
3. **依赖**用 lock 文件 + `--frozen` 安装，CI 与生产使用同一份 lock。

再加一句加分项：**定期跑 `uv lock --upgrade` 并做回归**，否则锁文件会变成"三年不敢动的化石"。

> 一句经验：**环境问题的根因永远是"某个环节没被版本化"**。找到那一层（解释器 / 环境 / 依赖）并把它写进文件，问题就不会再来第二次。
