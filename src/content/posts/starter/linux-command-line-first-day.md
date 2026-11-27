---
title: 第一次用命令行：12 个命令就能在 Linux 上活下来
description: 不用背 200 条命令。先把"我在哪个目录、这个文件谁能动、这个程序在不在跑"三件事解决，剩下的遇到再查。
date: 2026-11-26
tags: [入门, Linux, 命令行, 零基础]
---

图形界面能点出来的事，命令行也能做，而且能一次对十台机器做。新手怕命令，通常是因为不知道"命令在操作什么"。

## 一、命令行的三个基本事实

1. **命令就是程序**。`ls` 是一个叫 `ls` 的小程序，`cd` 是 shell 自带的功能，没有神秘之处。
2. **你永远处在某个目录里**。`pwd` 告诉你现在在哪，几乎所有相对路径都基于它。
3. **一切皆文件**。硬盘、网卡、进程信息在 Linux 里都能用文件方式访问（`/proc`、`/dev`），所以"看文件"这个动作能干很多事。

记住这三条，命令行就不再是黑箱。

## 二、12 个命令，覆盖 90% 的日常

### 1–3 我在哪、有什么、去哪

```bash
pwd                      # 我在哪个目录
ls -lh                   # 这个目录有什么（-l 详情，-h 人类可读大小）
cd /etc/nginx            # 进入某个目录；cd .. 返回上一级；cd ~ 回家目录
```

### 4–6 看文件、找东西、改文件

```bash
cat /etc/os-release      # 整个打印出来（短文件用）
less /var/log/syslog     # 分页看大文件，q 退出，/ 搜索
tail -f /var/log/nginx/access.log   # 实时跟随，排障看日志的命根子
grep -n "error" /var/log/nginx/error.log   # 找关键词，-n 显示行号
```

### 7–8 建、删、复制、移动

```bash
mkdir -p /data/www/site      # 建目录，-p 连父目录一起建
cp -r site site-bak          # 复制目录
mv site-bak /tmp/            # 移动/重命名
```

`rm -rf` 是**唯一需要停一秒再敲**的命令：它不问、不进回收站。练手时先在 `/tmp` 里玩。

### 9–10 权限与身份

```bash
whoami                   # 我当前是谁
ls -l                    # 看权限：-rw-r--r-- 1 root root
chmod 644 index.html     # 改权限（644 = 属主可读写，其他只读）
chown www-data:www-data index.html   # 改属主
```

权限先记三个数：**644 普通文件、755 目录或可执行文件、600 私钥**。剩下的遇到再学。

### 11 进程与服务

```bash
ps -ef | grep nginx      # 这个程序在不在跑
ss -lntp                 # 谁在监听哪个端口（排障第一命令）
systemctl status nginx   # 服务的状态、最近日志
systemctl restart nginx  # 重启服务
```

### 12 装软件

```bash
# Ubuntu / Debian
apt update && apt install -y nginx
# CentOS 7
yum install -y nginx
# Rocky / Alma / CentOS 8+
dnf install -y nginx
```

装完先用 `systemctl start` 启起来，`systemctl enable` 设开机自启——两个都要做，只 start 的话重启机器就没了。

## 三、练习：15 分钟做完这五件事

在一台练手机器上依次执行，每步都想一下"我在动哪一层"：

```bash
# 1. 建一个自己的目录并写个页面
mkdir -p ~/practice && cd ~/practice
echo "<h1>hello wild-think</h1>" > index.html

# 2. 看看它长什么样、权限是多少
ls -l index.html           # 应该是 -rw-r--r--

# 3. 故意改成 000，看还能不能读
chmod 000 index.html
cat index.html             # 会报 Permission denied（root 除外）
chmod 644 index.html

# 4. 起一个临时 Web 服务把它发出去
python3 -m http.server 8080
# 另开一个终端：curl -I http://127.0.0.1:8080

# 5. 观察端口与进程
ss -lntp | grep 8080       # 能看到 python3 在监听
ps -ef | grep http.server
```

第 3 步是刻意制造一次失败：**权限问题一定表现为 "Permission denied"，看到这四个字就别再猜别的了。**

## 四、新手最常踩的五个坑

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `command not found` | 没装 / 不在 PATH | `which 命令`；装包；检查 PATH |
| 改了配置不生效 | 没 reload | `systemctl reload nginx`（不是 restart 也可以） |
| 改完配置服务起不来 | 语法错 | `nginx -t` 先测再 reload |
| 编辑完文件内容乱 | 用了 `>` 覆盖 | `>` 是覆盖，`>>` 才是追加 |
| 关掉 SSH 就断了 | 前台进程随会话退出 | 用 `nohup` 或 `systemd` 托管 |

第一条和第四条能解决新手一半的"玄学问题"。

## 五、编辑器怎么选

只用记一个够用的：`vim`。最小操作集：

```text
i        进入编辑模式
Esc      回到普通模式
:wq      保存退出
:q!      不保存退出
/关键词   搜索
```

嫌麻烦就先装 `nano`（底部有快捷键提示，Ctrl+O 保存、Ctrl+X 退出）。**不要因为编辑器卡住就放弃命令行**——这是最常见的劝退点。

## 六、下一步

- 想搞懂"为什么别人访问不到我的页面"→ 看《IP、端口、域名、HTTP：四个词讲完网络入门》
- 想把页面变成"能查数据库的真网站"→ 看《LAMP 环境部署实验》
- 想搞懂服务为什么起不来 → 看 Linux 专题里的《systemctl start 失败之后》

> 一句经验：**命令不用背，要记的是"这个命令回答什么问题"**：`pwd` 回答"我在哪"，`ss` 回答"谁在占端口"，`tail -f` 回答"现在正在发生什么"。问题清楚了，命令自然会想起来。
