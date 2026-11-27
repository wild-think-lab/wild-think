---
title: 弄一台能随便折腾的机器
module: 入门篇
summary: 两条路：本机虚拟机，或云上买一台最低配。给命令、给配置、给"连不上怎么查"的清单。
minutes: 20
---

### 为什么先要一台"能弄坏"的机器

学 Linux 最怕的是"不敢动"。装在主力电脑上，改错一个配置就进不去系统，学习就停在这了。所以先准备一个**坏了能删掉重装**的环境。

两条路，选一条就够：

| 方式 | 成本 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 本机虚拟机（VirtualBox / VMware） | 免费 | 断网也能练，随便快照回滚 | 吃本机内存，要下载镜像 |
| 云服务器（最低配） | 几十元/月，常有试用 | 真远程环境，能练 SSH、防火墙 | 要花钱，纯命令行 |

新手建议先虚拟机：能截图、能回滚、不怕账单。

### 路线一：本机虚拟机

1. 装 VirtualBox（免费）或 VMware Workstation Player。
2. 下载镜像：Ubuntu Server 22.04/24.04 LTS 的 `.iso`（注意选 **Server** 版，不是桌面版，我们要练的就是命令行）。
3. 新建虚拟机：内存 2G、CPU 2 核、硬盘 20G，网络选 **NAT**（默认就能上网）。
4. 启动，选镜像安装，一路默认，只需注意两处：
   - 磁盘分区选"使用整个磁盘"（学习环境不需要精细分区）。
   - 一定要设好用户名和密码，并**记住**。
5. 装完重启，出现 `login:` 提示符就算成功。

装好后建议立刻做一个**快照**（VirtualBox 叫"备份"，VMware 叫"快照"）。以后任何一步搞坏了，回滚 10 秒解决。

### 路线二：云服务器

买一台最低配（1 核 2G 足够），系统镜像选 Ubuntu 22.04 或 Rocky 9。买完在控制台拿到公网 IP 和登录密码，然后本机开终端：

```bash
ssh root@你的公网IP
# 第一次会问 yes/no，输入 yes 接受指纹
# 然后输入密码
```

Windows 下直接用 PowerShell 或 Windows Terminal 里的 `ssh` 命令，不用装 PuTTY。

### 连不上？按顺序查这四件事

| 现象 | 大概率原因 | 怎么办 |
| --- | --- | --- |
| `Connection refused` | 服务端 sshd 没开，或端口不是 22 | 控制台确认 22 端口开放 |
| `Connection timed out` | 网络/安全组没放行 | 云厂商安全组加一条允许 22 端口 |
| `Permission denied` | 用户名或密码错 | root 密码在控制台重置；普通用户别用 root 登 |
| `Host key verification failed` | 本机记录了旧指纹 | 删掉 `~/.ssh/known_hosts` 里对应那一行 |

### 装好之后，先做三件事

```bash
sudo apt update && sudo apt upgrade -y   # Ubuntu/Debian 系更新
# Rocky/CentOS 系用：sudo dnf update -y

hostnamectl        # 看系统版本、主机名、内核
ip a               # 看自己的 IP，确认有网卡地址
ping -c 3 baidu.com  # 确认能上网、DNS 正常
```

`ping` 通说明网络和 DNS 都没问题；只报 `unknown host` 说明网络通但 DNS 坏了——这两种故障的原因完全不同，第 8 章会细讲。

### 本章小结

- 学习环境要能"弄坏重来"，优先虚拟机 + 快照。
- 装系统只关心三件事：镜像选 Server 版、密码记住、网络能通。
- 连不上先分清 refused（服务没开）和 timed out（网络没通）。

**下一章**：有了机器，先搞懂"文件放在哪、路径怎么走"。
