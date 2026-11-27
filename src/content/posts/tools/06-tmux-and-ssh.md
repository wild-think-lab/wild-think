---
title: tmux 与 SSH 效率清单：把"一天敲 300 次"的活省掉
description: tmux 的会话分离与窗口布局、SSH 的 config 与跳板复用、免密与 agent 转发、以及几条能立刻提速的操作习惯。
date: 2026-11-27
tags: [效率, tmux, SSH, 命令行]
---

### tmux：断线不掉任务的底线保障

装好就用三件事：

```bash
tmux new -s work          # 新建会话
# Ctrl-b d                # 分离（detach），进程继续跑
tmux ls                   # 列出会话
tmux a -t work            # 重新接入
```

**为什么必要**：任何一次 SSH 断线，跑了两小时的 `rsync`、正在执行的数据库迁移、`apt upgrade`，都会随连接一起死。tmux 让进程挂在服务端，与你的连接解耦。

`~/.tmux.conf`：

```conf
set -g prefix C-a
unbind C-b
bind C-a send-prefix

set -g mouse on
set -g history-limit 50000
set -g base-index 1
setw -g pane-base-index 1

# 用 | 和 - 分屏，更符合直觉
bind | split-window -h -c "#{pane_current_path}"
bind - split-window -v -c "#{pane_current_path}"

# 状态栏
set -g status-left "#[fg=#ff8a3d,bold] #S "
set -g status-right "#[fg=#888] %H:%M "
```

常用操作：

```
Ctrl-a c      新建窗口        Ctrl-a ,  重命名窗口
Ctrl-a |      竖分屏          Ctrl-a -  横分屏
Ctrl-a z      当前窗格放大     Ctrl-a { / }  交换窗格
Ctrl-a [      进入复制模式（可翻历史，q 退出）
Ctrl-a :resize-pane -D 10     下移 10 行
```

**会话持久化**：重启机器后会话丢失，用 `tmux-resurrect` 或 `tmux-continuum` 恢复布局。

### SSH config：把长命令变成别名

`~/.ssh/config`：

```sshconfig
Host lab
  HostName 10.0.0.21
  User ops
  Port 22
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
  ServerAliveCountMax 3

Host bastion
  HostName jump.example.com
  User ops
  IdentityFile ~/.ssh/id_ed25519

# 通过跳板机访问内网机器
Host db1
  HostName 10.1.0.5
  User dba
  ProxyJump bastion

# 多台机器共用跳板，连接复用减少握手
Host 10.1.*
  ProxyJump bastion
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

收益：

- `ssh lab` 替代 `ssh -i ~/.ssh/id_ed25519 -p 22 ops@10.0.0.21`。
- `ProxyJump` 替代"先登跳板再登内网"的两步操作。
- `ControlMaster` 让同一目标的第二个连接直接复用已有 TCP，**从 1 秒降到 20 毫秒**。批量执行 `for h in ...; do ssh $h cmd; done` 时差别巨大。

### 免密登录：一条命令搞定

```bash
ssh-keygen -t ed25519 -C "ops@example.com"     # 比 RSA 更短更安全
ssh-copy-id -i ~/.ssh/id_ed25519.pub lab
```

验证：

```bash
ssh -o BatchMode=yes lab true && echo ok
```

`BatchMode=yes` 保证"如果需要密码就直接失败"，适合写脚本时判断免密是否配好。

### Agent 转发与安全

```sshconfig
Host lab
  ForwardAgent yes
```

用 `ssh-agent` 转发后，本地私钥不必复制到服务器。但要注意：**在跳板机上有 root 的人可以借用你的 agent 认证**。

更安全的替代：

```sshconfig
Host lab
  ForwardAgent no
  # 用 ProxyJump 代替 agent 转发
```

原则：**能 ProxyJump 就不 ForwardAgent**。

### 一个能省大量时间的习惯

**用 `ssh host 'cmd'` 做远程单命令，而不是登录后手敲**：

```bash
# 检查 10 台机器的磁盘
for h in web{01..10}; do
  printf '%-8s ' "$h"
  ssh -o BatchMode=yes "$h" "df -h / | awk 'NR==2{print \$5}'"
done
```

配合 `GNU parallel`：

```bash
printf '%s\n' web{01..10} | parallel -j 5 'ssh {} "uptime | awk -F\"load average:\" \"{print \\\$2}\""'
```

### scp / rsync 的正确选择

| 需求 | 工具 |
| --- | --- |
| 单个小文件 | `scp` |
| 目录、需要增量、断点续传 | `rsync -avz --partial --progress` |
| 大量小文件 | `rsync` + `--delete`，或打包后传 |

```bash
rsync -avz --partial --progress --exclude='.git' ./src/ lab:/srv/app/src/
```

`--partial` 让中断后能续传，`--exclude` 避免传无关文件——**没有 exclude 的 rsync 常常把 node_modules 传上去**。

### 端口转发：三种场景

```bash
# 本地访问远端内网服务（最常见）
ssh -L 8080:internal-svc:80 bastion
# 现在 localhost:8080 → internal-svc:80

# 远端访问本地服务（临时给外部调试）
ssh -R 9000:localhost:8000 lab

# 把远端端口当 SOCKS 代理（浏览内网面板）
ssh -D 1080 bastion
```

`-D` 配合浏览器代理设置，可以在不装 VPN 的情况下访问内网 Web 面板。但**只用于临时排障**，长期用要走正式 VPN/零信任。

### 三条纪律

1. **不要在服务器上留私钥**（很多人为了免密把私钥拷上去，等于把钥匙留在锁上）。
2. **禁用密码登录**，只留公钥：

```conf
# /etc/ssh/sshd_config
PasswordAuthentication no
PermitRootLogin no
MaxAuthTries 3
```

3. **改端口不等于安全**，但能减少 90% 的自动扫描噪音。

```bash
sshd -t && systemctl reload sshd     # 改完先测配置，别把自己锁外面
```
