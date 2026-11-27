---
title: 我的终端工具箱：十来件真正每天在用的东西
description: 不是"50 个神仙工具"清单，而是能说清"解决什么问题、替代了什么、什么时候不要用"的十来件。
date: 2026-11-15
tags: [效率工具, 终端, 命令行, 运维]
---

工具清单的价值不在数量，在于**每件都能说清它替代了什么手工操作**。下面按使用频率排列，附一句"什么时候别用"。

## 一、替代 ssh 与复制粘贴

### tmux

解决的问题：断线丢会话、一屏开多个窗口、长任务不随终端退出。

```bash
tmux new -s work          # 新建会话
tmux attach -t work       # 重连
# 前缀键 Ctrl-b：% 竖分屏，o 切窗格，d 脱离
```

**别用时**：只是跑一条 2 秒的命令，tmux 是负担。

### ssh 配置化

把常用主机写进 `~/.ssh/config`，消除重复参数：

```sshconfig
Host web1
  HostName 10.0.0.11
  User deploy
  Port 22
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
  ServerAliveCountMax 3

Host *
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

`ControlPersist` 复用连接后，连续 ssh/scp 几乎瞬时，这是最被低估的一项优化。

## 二、替代"翻目录找东西"

### fd（替代 find）

```bash
fd -e md -x wc -l          # 找 md 并统计行数
fd -t f -H 'config' /etc   # 含隐藏文件
```

比 `find` 语法友好，默认忽略 `.gitignore` 内容。**别用时**：需要复杂表达式（`-perm`、`-newermt`）时，`find` 仍是唯一选择。

### ripgrep（rg，替代 grep -r）

```bash
rg -n 'PasswordAuthentication' /etc/ssh
rg -t py 'subprocess' --stats
rg -l 'TODO' | head
```

自动跳过二进制与 `.gitignore`，速度快一个量级。**别用时**：需要回溯压缩日志时用 `zgrep`。

### jq

```bash
curl -s api/status | jq '.data[] | {id, state}'
kubectl get pod -o json | jq -r '.items[].metadata.name'
```

**别用时**：只需看一两个字段时，`grep -o` 更省事。

## 三、替代"凭感觉判断系统状态"

### htop / bottom

比我更爱用的是 `htop` 的树形视图（F5）与按 CPU 排序（P）。容器里 `top` 显示的 CPU% 是宿主机口径，`htop` 也是——**容器限额要看 cgroup，不是看 htop**。

### iostat + iotop

```bash
iostat -x 1 3
iotop -oPa
```

判断磁盘饱和看 `await` 与 `aqu-sz`，`%util` 在 NVMe 上不可靠。

### ss（替代 netstat）

```bash
ss -lntp                      # 监听
ss -tan state established     # 已建立
ss -ti                        # TCP 内部状态（cwnd/rtt/retrans）
```

`ss -ti` 是排查"慢但不丢"的利器，能看到拥塞窗口与重传计数。

### nethogs / iftop

```bash
nethogs eth0     # 按进程看带宽
iftop -i eth0    # 按连接看流量
```

**别用时**：抓包分析用 `tcpdump`，这两个只回答"谁在用带宽"，不回答"为什么慢"。

## 四、替代"手工对比与搬运"

### rsync

```bash
rsync -avz --delete --dry-run src/ dst/     # 先 dry-run，永远
rsync -avz --partial --progress big.iso host:/data/
```

`--delete` 是危险参数，永远先 `--dry-run` 看清单。

### mtr（替代 ping + traceroute）

```bash
mtr -n -c 50 target
```

一次给出逐跳丢包率与延迟分布。**注意 ICMP 限速会造成"假丢包"**，判据是后续跳是否恢复正常。

## 五、编辑器侧的两个配置

```vim
" ~/.vimrc 最小可用集
set number relativenumber
set expandtab shiftwidth=2 tabstop=2
set ignorecase smartcase
set undofile
nnoremap <leader>w :w<CR>
```

`undofile` 让重启后还能撤销，这一条比装插件更有价值。

## 六、我不用什么

- **不用一堆美化 shell 框架**：提示符花哨会拖慢大仓库里的 `cd`，且排查别人机器时不存在。
- **不用 alias 覆盖原生命令**（如把 `rm` 改成 `rm -i`）：换一台机器就失效，且容易误伤脚本。
- **不用"一键优化脚本"**：它改的内核参数你不知道为什么改，出问题也无法回滚。

> 一条判断标准：**能说清"它替代了我原来哪三步手工操作"的工具才值得装，其余的都会变成负担。**
