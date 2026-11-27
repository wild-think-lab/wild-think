---
title: 软件包管理：装、卸、查、升级
module: 入门篇
summary: 两套命令体系（apt 与 dnf/yum）的对照表，仓库、依赖、锁问题一次讲清。
minutes: 18
---

### 先分清你的系统是哪一套

Linux 装软件有两套主流体系，命令完全不同。**教程装不上，八成是抄了另一套的命令。**

| 系统 | 工具 | 装包 | 查包 | 卸载 |
| --- | --- | --- | --- | --- |
| Ubuntu / Debian | apt | `apt install nginx` | `apt search nginx` | `apt remove nginx` |
| Rocky / CentOS / openEuler | dnf（旧版 yum） | `dnf install nginx` | `dnf search nginx` | `dnf remove nginx` |

先确认自己是谁：

```bash
cat /etc/os-release | head -2
```

### 装之前先 update，这不是仪式

```bash
sudo apt update          # 刷新"软件清单"（不是升级软件）
sudo apt upgrade -y      # 按新清单升级已装的软件
```

`update` 只是让本机知道远端仓库里现在有哪些版本。不刷新清单就 `install`，会出现"装的是旧版本"或"找不到包"。

### 依赖是什么

你装 nginx，它需要 `pcre`、`zlib`、`openssl`。包管理器会自动把这些一并装上——这是它比自己编译源码最大的优势。

反过来，卸载时如果某个包被别人依赖，会提示"还有别的包需要它"。这时候别强删，先想清楚谁在用。

### 查：装没装、装在哪、谁提供的

```bash
dpkg -l | grep nginx        # Debian 系：已安装的包
rpm -qa | grep nginx        # RHEL 系：已安装的包

which nginx                 # 命令在哪
nginx -V                    # 版本 + 编译参数（排"功能不存在"很有用）

systemctl status nginx      # 装完有没有跑起来
```

### 仓库（repo）与"包找不到"

`apt install` 找不到包，通常是三件事：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Unable to locate package` | 仓库里没有，或没 `update` | 先 `update`；确认包名；加第三方仓库 |
| `Could not resolve host` | DNS 不通 | 修 DNS（见第 8 章） |
| `404 Not Found`（旧系统常见） | 发行版已 EOL，镜像源地址失效 | 换可用的镜像源 |

CentOS 7 已于 2024 年 6 月停止维护，官方源失效是必然的，需要换 vault 归档源或直接升系统。**给还在用 CentOS 7 的机器装新软件，本质上是在给一栋拆掉的楼换窗户。**

### 别用"编译源码"当默认方案

网上很多教程让你 `./configure && make && make install`。这套能行，但：

- 依赖要自己装，缺一个就报错，报错信息还看不懂；
- 装完**没有**卸载方式（除非你记得当时装到哪）；
- 升级要重来一遍，出问题难回滚。

**正确姿势**：能用包管理器就用包管理器；确实需要特定版本或特定编译参数（比如自定义模块），再编。真的要编，装到 `/opt/软件名-版本` 里，方便整个目录删掉。

### 自己验证

```bash
sudo apt install -y nginx     # Rocky 系换成 dnf
nginx -v
systemctl is-active nginx     # 期望输出 active
curl -I http://localhost      # 期望 200/301
```

四步走完，你已经独立部署了一个服务。

### 本章小结

- Ubuntu 用 `apt`，Rocky 系用 `dnf`，别抄错体系。
- `update` 刷清单，`upgrade` 升软件，两个不是一回事。
- 包管理器管依赖，这是它比源码编译可靠的根本原因。
- 装不上先看：仓库有没有、DNS 通不通、源是否已失效。

**下一章**：程序怎么在后台一直活着——进程与服务。
