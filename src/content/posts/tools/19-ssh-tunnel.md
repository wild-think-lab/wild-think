---
title: SSH 隧道：把"不能直连"变成"像本地一样"
description: 本地/远程/动态三种转发的区别、五个实战用法，以及五个"隧道连上了但不通"的原因。
date: 2026-11-27
tags: [工具, SSH, 隧道]
---

### 三种转发

```
-L 本地转发：本地端口 → 远端能访问的目标（最常用）
-R 远程转发：远端端口 → 本地能访问的目标（穿透内网）
-D 动态转发：本地 SOCKS 代理（灵活）
```

**记忆法**：

```
-L 是"我这边开个口，从远端出去"
-R 是"远端开个口，从我这出去"
```

### -L：把远端的数据库拉到本地

```bash
ssh -L 13306:db.internal:3306 jump@bastion
# 本地连 127.0.0.1:13306 就等于连 db.internal:3306
```

**要点**：

```
-L [本地IP:]本地端口:目标主机:目标端口
目标主机是从"跳板机视角"解析的
```

**"连不上 127.0.0.1:13306"**：

```
① -L 写成 -l（大小写）
② 只监听 127.0.0.1（-g 才监听所有）
③ 本地端口被占用
```

### -R：让外部访问我的内网服务

```bash
# 在没有公网 IP 的机器上
ssh -R 8080:localhost:80 user@public-server
# 外部访问 public-server:8080 → 打到内网的 80
```

**常见限制**：

```
sshd_config 里的 GatewayPorts（决定远端是否监听 0.0.0.0）
```

```conf
GatewayPorts yes
```

**"远端只能从 localhost 访问"** → 就是这个配置。

### -D：一个临时 SOCKS 代理

```bash
ssh -D 1080 user@bastion
# 浏览器/命令行配 socks5://127.0.0.1:1080
curl --socks5 127.0.0.1:1080 http://internal.example.com/
```

**用途**：

```
临时访问内网多个服务（比逐个 -L 方便）
```

### 五个实战用法

**① 跳板机（ProxyJump）**

```bash
ssh -J bastion app-server
# ~/.ssh/config
Host app
  HostName 10.0.0.10
  ProxyJump bastion
```

**比 `ssh -L` 更干净**（一条连接直达）。

**② 长连接不断**

```bash
ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L ...
```

**"隧道几分钟就断"** → 中间 NAT/防火墙掐空闲连接。

**③ 后台运行**

```bash
ssh -fN -L 13306:db:3306 bastion
```

**`-f`（后台）+ `-N`（不执行命令）**，适合做长期隧道。

**④ 用 autossh 保活**

```bash
autossh -M 0 -fN -L 13306:db:3306 bastion -o ServerAliveInterval=30
```

**"断了自动重连"** 才适合长期使用。

**⑤ 隧道 + 只允许特定命令**

```bash
# authorized_keys 里限制
command="nc localhost 3306",no-pty ssh-rsa AAA...
```

**"给隧道专用账号只放行一条目标"** 比给 shell 安全。

### 五个"隧道连上了但不通"

**① 目标主机名在远端解析不了**

```
-L 的目标是"从远端视角"解析
→ 远端没这条 DNS/ hosts → 连不上
```

**② 远端到目标端口不通**

```
在远端上先测：nc -zv db.internal 3306
```

**③ 本地端口已被占用**

```bash
ss -lntp | grep 13306
```

**④ 只监听 localhost，容器/其他机器访问不到**

```
加 -g（并确认服务端 AllowTcpForwarding）
```

**⑤ 服务端禁止转发**

```conf
AllowTcpForwarding no    # 需要 yes 或 local/remote
```

### 安全提醒

```
① 隧道等于"开了个内部入口"，用完就关
② 不要在公网机器上长期开着 -R（暴露内网）
③ 用专用账号 + 限制命令
④ 记录"谁开了什么隧道"（隧道是审计盲区）
```

**"临时开的隧道忘了关"** 是常见的安全隐患。

### 检查清单

```
□ 分清 -L/-R/-D 的方向
□ 会用 ProxyJump 代替手工 -L
□ 长连接配 ServerAlive*
□ 长期隧道用 autossh
□ 确认远端 DNS 与端口可达
□ GatewayPorts/AllowTcpForwarding 检查
□ 用完即关（不留长期 -R）
□ 隧道账号限制命令
□ 有"隧道清单"审计
```
