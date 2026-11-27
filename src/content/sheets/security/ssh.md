---
title: SSH 安全与运维速查
summary: 密钥登录怎么配、sshd 该关哪些开关、跳板与端口转发、免密与多账号、会话保持与审计，含一条条能直接粘的配置。
group: 安全
order: 8
tags: [SSH, 安全加固, 运维]
---

## 生成密钥，选对算法

```bash
ssh-keygen -t ed25519 -a 100 -C "wang@laptop-2026" -f ~/.ssh/id_ed25519
# 兼容老系统的 RSA（4096 位）
ssh-keygen -t rsa -b 4096 -o -a 100 -f ~/.ssh/id_rsa
```

`-a 100` 是 KDF 轮数，能显著提高暴力破解成本。**不要**用默认的 `-t rsa` 2048。

## 安装公钥（两种方式）

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@host
# 没装 ssh-copy-id 时手动
cat ~/.ssh/id_ed25519.pub | ssh user@host 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

权限错了 sshd 会静默拒绝：`~/.ssh` 700、`authorized_keys` 600、家目录不能 group/world 可写。

## sshd 加固基线

```ini
# /etc/ssh/sshd_config.d/99-hardening.conf
Port 22
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 20
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers deploy ops
X11Forwarding no
AllowAgentForwarding no
PermitEmptyPasswords no
UseDNS no
```

改完**先别重启 sshd**，用另一个窗口验证能连上再 `systemctl reload sshd`——这是最容易把自己锁在门外的一步。

`UseDNS no` 能避免登录时反向解析卡 30 秒。

## config 文件：少敲一半命令

```sshconfig
Host prod-web
    HostName 203.0.113.10
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
    ServerAliveCountMax 3
    StrictHostKeyChecking accept-new

Host *.corp.local
    User ops
    ProxyJump bastion
```

`ProxyJump` 替代了老式 `ProxyCommand`，跳板机场景一行搞定。`StrictHostKeyChecking accept-new` 兼顾安全与自动化。

## 端口转发四种

```bash
# 本地转发：把远端 3306 拉到本地
ssh -L 13306:127.0.0.1:3306 deploy@db-host
# 远端转发：把本地 8080 暴露到远端
ssh -R 8080:127.0.0.1:80 deploy@public-host
# 动态转发（SOCKS5 代理）
ssh -D 1080 -N deploy@bastion
# 跳板
ssh -J bastion deploy@10.0.0.21
```

`-N` 不执行命令，纯转发时必加；后台跑配 `-f`。

## 免交互与批量

```bash
ssh-agent bash -c 'ssh-add ~/.ssh/id_ed25519; ssh host "uptime"'
# 批量
for h in web1 web2 web3; do ssh -o BatchMode=yes "$h" 'systemctl is-active nginx'; done
```

`BatchMode=yes` 在脚本里必须加：不然一旦需要密码，脚本会挂在那里等输入（CI 里表现为超时）。

## 传输

```bash
scp -r ./dist deploy@host:/opt/app/
rsync -avz --delete ./dist/ deploy@host:/opt/app/    # 增量，比 scp 适合反复同步
rsync -avz --dry-run ./dist/ deploy@host:/opt/app/   # 先看会删什么
sftp deploy@host
```

`rsync --delete` 会删掉目标端多余文件，一定先 `--dry-run`。

## 会话保持与审计

```bash
tmux new -s work        # 断线不丢
tmux attach -t work
screen -S work
```

审计（合规场景）：

```ini
# sshd 里开启会话记录
ForceCommand /usr/local/bin/log-session.sh
```

轻量版：`script -f /var/log/session/$(date +%s).log` 包一层 shell。

## 常见连不上，按顺序查

1. `ssh -vvv user@host`（先看卡在哪一步：TCP → 认证 → 会话）
2. 网络：`nc -vz host 22`，防火墙与安全组。
3. 权限：`ls -ld ~ ~/.ssh ~/.ssh/authorized_keys`。
4. 日志：`journalctl -u sshd -n 50`，常见 `Authentication refused: bad ownership or modes`。
5. 磁盘满：`No space left on device` 会导致登录直接失败（`.ssh` 无法写）。
6. `Too many authentication failures`：本地加载了太多 key，加 `-o IdentitiesOnly=yes`。

## 顺手的三条检查

```bash
# 谁在登录
who; last -n 20
# 失败的登录尝试（爆破迹象）
journalctl -u sshd | grep -c 'Failed password'
# 监听端口是否被改
ss -lntp | grep sshd
```

最后一条常被忘：真有人把 22 改成 2222，然后记录里还是写的 22。
