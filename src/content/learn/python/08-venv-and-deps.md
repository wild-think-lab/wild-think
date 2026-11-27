---
title: 虚拟环境与依赖管理
module: 进阶篇
summary: 一个项目一个环境，requirements.txt 让"我电脑上能跑"变成"哪都能跑"。
minutes: 20
---

### 为什么会有虚拟环境

假设你同时做两个项目：

- A 项目要 `requests==2.20`
- B 项目要 `requests==2.31`

装在系统 Python 里只有一个版本，必有一个项目坏掉。更糟的是系统自带的 Python 被系统工具依赖，你升级了库，可能把包管理器本身搞坏。

**虚拟环境**：给每个项目一个独立的库目录，互不干扰。

### 三条命令就够

```bash
cd ~/lab/myproj
python3 -m venv .venv          # 建环境，实际是建一个 .venv 目录
source .venv/bin/activate      # Linux/macOS 激活
# Windows PowerShell: .venv\Scripts\Activate.ps1

pip install requests
pip list
deactivate                     # 退出
```

激活后命令行前面会出现 `(.venv)`，此时 `python`、`pip` 都指向这个环境内部，装东西只影响这里。

**记住两件事**：`.venv` 目录**不要提交到 git**（写进 `.gitignore`），换机器重新建就行；每次开工先激活。

### requirements.txt：把依赖固定下来

```bash
pip freeze > requirements.txt     # 导出当前环境所有包和精确版本
pip install -r requirements.txt   # 别人拿到项目一条命令还原
```

文件内容长这样：

```text
requests==2.31.0
urllib3==2.2.1
certifi==2024.2.2
```

`pip freeze` 会把所有间接依赖都写进去，对交付来说这是好事——版本完全可复现。

手写时只写直接依赖（不带 `==`）也行，但容易出现"今天装得上、三个月后装不上"的漂移。要可复现就锁版本。

### 国内安装慢怎么办

```bash
pip install requests -i https://pypi.tuna.tsinghua.edu.cn/simple
```

或者写进配置一次搞定：

```bash
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

### 依赖装不上时的排查顺序

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `No matching distribution found` | 包名错 / 版本不存在 / 源没有 | 核对名字，换源，`pip index versions 包名` |
| 编译报错 `gcc failed` | 该包要编译，缺系统库 | 装 `python3-dev`、`build-essential` 等 |
| `Permission denied` | 用了系统 Python 又没权限 | 先激活 venv，别 `sudo pip` |
| 装了却 import 不到 | 用错了 Python 解释器 | `which python` 确认在 venv 里 |

`sudo pip install` 是最差的选择：它会把包装进系统目录，权限混乱、版本冲突，还绕过了虚拟环境的全部好处。

### 什么时候该上 Poetry / uv

项目变大、要区分开发依赖和生产依赖、要锁定完整依赖树时，用 `uv` 或 `poetry` 更省心。但**先用好 venv + requirements.txt**，这套足够覆盖 90% 的脚本和中小项目。

### 自己验证

```bash
mkdir -p ~/lab/proj && cd ~/lab/proj
python3 -m venv .venv
source .venv/bin/activate
pip install requests
pip freeze > requirements.txt
cat requirements.txt
deactivate
```

再建一个新目录、新建 venv、`pip install -r requirements.txt`，确认能一条命令还原——这就是"可交付"的样子。

### 本章小结

- 一个项目一个虚拟环境，`python3 -m venv .venv` + 激活。
- `.venv` 不提交 git，`requirements.txt` 提交。
- 国内换镜像源解决慢；别 `sudo pip`。
- 可复现的标准：别人 `pip install -r requirements.txt` 就能跑。

**这门课读完了。** 下一步建议：用这三样东西写一个真正有用的小工具——比如读日志、数 IP、导出报表。
