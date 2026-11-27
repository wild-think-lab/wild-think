---
title: 装环境：解释器、编辑器、第一次运行
module: 入门篇
summary: Windows 与 Linux 两条安装路径，加一个"装完必须验证"的清单，避免第一天就卡在环境上。
minutes: 15
---

### 要装的东西只有两样

- **解释器**：真正执行 Python 代码的程序（`python` 命令）。
- **编辑器**：写代码的地方。VS Code 免费、跨平台、插件全，够用很久。

不需要装"整套 IDE"，也不需要一次装十个库。

### Windows

1. 到 python.org 下载 3.10 以上版本的安装包。
2. 安装第一屏**必须勾选 `Add python.exe to PATH`**，不勾的话后续命令行里敲 `python` 会提示找不到。
3. 勾完选 `Install Now`。

验证（开 PowerShell）：

```powershell
python --version     # 期望 Python 3.x.x
pip --version        # 期望显示版本和路径
```

如果 `python` 打不开但 `py` 可以，说明 PATH 没配好。重装一次并勾选 PATH 比手工改环境变量省事。

### Linux / macOS

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y python3 python3-pip python3-venv

# Rocky / CentOS
sudo dnf install -y python3 python3-pip

python3 --version
pip3 --version
```

Linux 下命令叫 `python3`，因为 `python` 这个名字历史上被 Python 2 占着。**不要**为了省事把系统的 `python` 链接改到 `python3`，很多系统工具依赖旧路径。

### 第一次运行：三种方式

**① 交互模式**（临时算点东西）

```bash
python3
>>> 1 + 2
3
>>> exit()
```

**② 脚本文件**（正式做法）

新建 `hello.py`：

```python
name = "wild-think"
print(f"hello, {name}")
```

```bash
python3 hello.py
# hello, wild-think
```

**③ VS Code 里按运行键**：本质和 ② 一样，只是帮你拼好了命令。真正要学会的是 ②。

### 装完先验证这四件事

```bash
python3 --version              # 解释器在
pip3 --version                 # 包管理器在
python3 -c "print('ok')"       # 能执行代码
python3 -m venv /tmp/vtest && rm -rf /tmp/vtest   # venv 可用（第 8 章要用）
```

第四条最容易被忽略：有些发行版的 Python 装了但没装 `venv` 模块，等到第 8 章才发现，白折腾一轮。

### 写代码的三个习惯

1. **一个文件一个功能**，别写成 500 行的 `main.py`。
2. **文件名别用中文和空格**，`my script.py` 会让命令行报错。
3. **第一次跑不通先看最后一行报错**，Python 的报错从下往上读。

### 本章小结

- 只需要解释器 + 编辑器，别一开始装一堆库。
- Windows 安装时勾 `Add to PATH`，Linux 用 `python3`。
- 验证清单四项，尤其别忘了 `venv`。
- 正式写法是"存成 .py 再执行"，交互模式只用来试算。

**下一章**：变量和数据类型——程序里所有东西的容器。
