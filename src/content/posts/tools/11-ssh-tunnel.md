---
title: SSH 隧道：不装 VPN 也能安全连内网
description: 三种转发的区别、五个真实使用场景、保持连接的写法、以及"隧道能用但连不上数据库"的排查。
date: 2024-01-01
tags: [SSH, 隧道, 远程访问, 网络]
---

### 三种转发

```
本地转发（-L）：本机端口 → 远程侧的目标
   ssh -L 13306:db-internal:3306 user@jump
   本机 localhost:13306 的流量，经 jump 转发到 db-internal:3306

远程转发（-R）：远程端口 → 本机侧的目标
   ssh -R 8080:localhost:80 user@public
   访问 public:8080 → 转发回你本机的 80

动态转发（-D）：本机一个 SOCKS 代理，目的地任意
   ssh -D 1080 user@jump
   浏览器/工具用 socks5://127.0.0.1:1080 → 所有流量走 jump
```

**记法**：`-L` 是"把远端的服务拉到本地"，`-R` 是"把本地的服务推到远端"。

### 五个真实场景

**① 连内网数据库（最常见的 -L）**

```bash
ssh -f -N -L 13306:10.0.0.10:3306 ops@jump.example.com
mysql -h 127.0.0.1 -P 13306 -u app -p
```

- `-f`：后台运行
- `-N`：不执行远程命令（只做转发）

**② 访问内网 Web 后台**

```bash
ssh -f -N -L 18080:10.0.0.20:80 ops@jump
# 浏览器打开 http://127.0.0.1:18080
```

**③ 让同事临时访问你本机的服务（-R）**

```bash
# 你在本地跑了个 demo：localhost:8080
ssh -R 9000:localhost:8080 ops@public-server
# 同事访问 public-server:9000 就能看到
```

前提：服务端 `sshd_config` 允许 `GatewayPorts`（否则只绑 127.0.0.1）。

**④ 全局代理（-D）**

```bash
ssh -D 1080 -f -N ops@jump
curl --socks5-hostname 127.0.0.1:1080 https://internal.example.com
```

**⑤ 多跳（跳板机 → 目标机）**

```bash
# 方法 A：ProxyJump（推荐）
ssh -J ops@jump ops@target

# 方法 B：多层 -L
ssh -f -N -L 2222:target:22 ops@jump
ssh -p 2222 ops@127.0.0.1
```

`~/.ssh/config` 里固化：

```
Host target
    HostName 10.0.0.30
    User ops
    ProxyJump jump

Host jump
    HostName jump.example.com
    User ops
    Port 2222
```

之后直接 `ssh target`。

### 保持连接

```bash
# 客户端侧
ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ...
```

`~/.ssh/config`：

```
Host *
    ServerAliveInterval 30
    ServerAliveCountMax 3
    TCPKeepAlive yes
```

**两条的区别**：

- `ServerAliveInterval`：加密通道内的心跳（能穿过 NAT）
- `TCPKeepAlive`：TCP 层 keepalive（NAT 可能不转发）

建议两个都开。

**长期隧道用 autossh**：

```bash
autossh -M 0 -f -N -L 13306:10.0.0.10:3306 ops@jump \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes
```

`-M 0` 表示用 SSH 心跳而不是额外的监控端口。

### "隧道能用但连不上数据库"

按顺序查：

**① 转发建起来了吗**

```bash
ss -tlnp | grep 13306        # 本机应该有监听
ps aux | grep 'ssh -f -N'
```

**② 目标地址是"从跳板机看"的地址**

```
❌ ssh -L 13306:localhost:3306 ops@jump
   → 这里的 localhost 是跳板机的 localhost，不是数据库
✅ ssh -L 13306:10.0.0.10:3306 ops@jump
```

这是最常见的错误。

**③ 跳板机能连到目标吗**

```bash
ssh ops@jump 'nc -zv 10.0.0.10 3306'
```

不能 → 问题在跳板机到数据库（网络/防火墙）。

**④ 数据库允许来自跳板机的连接吗**

```sql
-- MySQL：账号的 host 限制
SELECT user, host FROM mysql.user WHERE user='app';
-- 如果是 'app'@'10.0.0.5'（只允许应用机），跳板机的 IP 就不行
```

**⑤ 端口冲突**

本机 13306 已被占用 → `-L` 会失败但可能没有明显提示。加 `ExitOnForwardFailure=yes`。

### 安全注意事项

```
① 隧道是"绕过防火墙"的手段，必须配合审计
   - 跳板机要记录所有隧道（命令审计）
   - 禁止在个人笔记本上开长期隧道
② 不要把隧道暴露到公网（-R 到 0.0.0.0）
③ 隧道用的账号权限要最小
④ 长期隧道要有清单与负责人（否则没人知道谁开了什么）
```

**审计方法**：跳板机的 `sshd` 加 `ForceCommand` 或在 `authorized_keys` 里加 `command=` 限制。

### 检查清单

```
□ 分清 -L / -R / -D 的方向
□ -L 的目标地址写"从跳板机看"的地址
□ 加 ServerAliveInterval 防断
□ 长期隧道用 autossh
□ 加 ExitOnForwardFailure=yes
□ 跳板机能连到目标是前提
□ 隧道有清单与审计
```
