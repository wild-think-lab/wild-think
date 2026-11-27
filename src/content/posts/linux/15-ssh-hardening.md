---
title: SSH 加固与堡垒机：不只是改端口
description: 十项 SSH 加固、密钥管理、跳板与堡垒机的取舍、以及"禁了密码还用不了"的三个原因。
date: 2026-11-27
tags: [Linux, SSH, 安全, 加固]
---

### 改端口不是安全措施

```
改 22 为 2222：
- 减少扫描日志噪音（有用）
- 挡住自动化脚本（有用）
- 挡住真正的攻击者？没用
```

**真正的加固是"减少攻击面 + 强认证 + 可审计"**。

### 十项加固

**① 禁止 root 直接登录**

```conf
PermitRootLogin no
```

**为什么**：root 用户名是固定的，攻击者只需爆破密码；普通用户 + sudo 至少要知道用户名。

**② 禁用密码登录**

```conf
PasswordAuthentication no
PubkeyAuthentication yes
```

**前提**：确认所有用户都已配置密钥（否则会把自己锁在外面）。

**③ 限定可登录用户/组**

```conf
AllowUsers deploy ops
# 或
AllowGroups ssh-users
```

**④ 限制来源 IP**

```conf
# /etc/hosts.allow（传统，部分系统已不用）
sshd: 10.0.0.0/8
```

**更可靠的方式**：防火墙/安全组限制 22 端口来源。

**⑤ 关闭不必要的转发**

```conf
AllowAgentForwarding no
AllowTcpForwarding no        # 不需要隧道时关掉
X11Forwarding no
PermitTunnel no
```

**注意**：`AllowTcpForwarding no` 会让 `ssh -L` 隧道失效（有需要就保留，但要知道风险）。

**⑥ 限制认证尝试**

```conf
MaxAuthTries 3
MaxSessions 5
LoginGraceTime 30
```

**⑦ 禁用弱算法**

```conf
KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
HostKeyAlgorithms ssh-ed25519,rsa-sha2-512
```

**用 `ssh -Q cipher` 等命令查看本机支持哪些**。

**⑧ 空闲超时**

```conf
ClientAliveInterval 300
ClientAliveCountMax 2
```

（5 分钟无响应就断开，25 分钟无活动则终止）

**⑨ 日志与审计**

```conf
LogLevel VERBOSE
SyslogFacility AUTH
```

**`VERBOSE` 会记录密钥指纹**（能追到"谁用什么密钥登录的"）。

**⑩ 双因素（可选但强烈建议）**

```conf
AuthenticationMethods publickey,keyboard-interactive
```

配合 PAM 的 TOTP（google-authenticator）。

### 密钥管理

**生成（用 ed25519）**：

```bash
ssh-keygen -t ed25519 -C "ops@company" -f ~/.ssh/id_ed25519
```

**为什么不用 RSA 2048**：ed25519 更短更快，且没有 RSA 的参数陷阱。

**分发**：

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@host
```

**在服务端限制密钥的能力（authorized_keys 的 options）**：

```
from="10.0.0.0/8",command="/usr/local/bin/backup.sh",no-port-forwarding ssh-ed25519 AAAA...
```

**这四个限制很有用**：

```
from=              只允许特定来源
command=           只能执行这一条命令（其他都拒绝）
no-port-forwarding 禁止隧道
no-pty             不分配终端
```

**轮换与吊销**：

```
① 每台机器的 authorized_keys 集中管理（配置管理下发，不手工改）
② 人员离职 → 从所有机器的 authorized_keys 移除
③ 定期审计：哪些密钥还在、对应谁
```

**审计脚本**：

```bash
# 列出所有机器上的所有公钥（配合 Ansible/for 循环）
for h in $(cat hosts.txt); do
  echo "== $h"
  ssh "$h" 'cat ~/.ssh/authorized_keys 2>/dev/null | while read l; do echo "$l" | awk "{print \$NF}"; done'
done
```

### 跳板 vs 堡垒机

| | 跳板机（Bastion） | 堡垒机（PAM/JumpServer） |
| --- | --- | --- |
| 做法 | 一台机器，SSH 转发 | 代理登录，记录操作 |
| 成本 | 低 | 中 |
| 审计 | 只有登录日志 | 完整命令/录像 |
| 运维 | 手工管密钥 | 统一账号与授权 |

**中间方案：SSH 跳板 + 强制日志**

```conf
# 跳板机上：所有会话录制
# 用 script 或 tlog（terminal session recording）
```

**`tlog`（RHEL 自带）能录制会话并存到中央**：

```bash
yum install tlog
# /etc/tlog/tlog-rec-session.conf
tlog-play -r journal -M TLOG_REC=<rec_id>
```

**2026 年的推荐**：

```
规模 < 50 台 → 跳板机 + 密钥集中管理 + 会话录制
规模 > 50 台 → 堡垒机（JumpServer/Teleport）
```

**Teleport 是开源的，值得一看**：它把"证书 + 短期凭证 + 审计"做在一起，比手管 SSH 密钥省事。

### "禁了密码还用不了"的三个原因

**① 密钥权限不对**

```bash
# 服务端要求 .ssh 与私钥权限严格
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
chmod 700 ~/.ssh/id_ed25519      # 客户端私钥
```

**权限太松（如 644）会被 sshd 拒绝**，日志里写 `Authentication refused: bad ownership or modes`。

**② SELinux 上下文不对**

```bash
restorecon -R -v ~/.ssh
ls -Z ~/.ssh/authorized_keys
# 应为 ssh_home_t
```

**手工 `cp` 的密钥文件常常上下文错误**。

**③ 家目录权限太松**

```bash
# 家目录不能是 777 或组可写
chmod 755 /home/user
```

**排查命令**：

```bash
sshd -T | grep -E "permitrootlogin|passwordauthentication|pubkeyauthentication"
tail -f /var/log/auth.log       # 或 /var/log/secure
```

`sshd -T` 打印**实际生效的配置**（比看配置文件可靠，因为 include 与默认值会影响）。

### 上线前的自查

```bash
# 1. 确认配置生效（不是改了文件就以为生效）
sshd -T

# 2. 在新终端测试（别关掉当前会话！）
ssh -o PreferredAuthentications=publickey user@host

# 3. 确认密码登录真的被拒
ssh -o PreferredAuthentications=password user@host     # 应失败

# 4. 确认 root 不能直登
ssh root@host       # 应失败
```

**"改完 sshd 配置直接 `systemctl restart` 并关掉终端"是最经典的自锁操作**。

**永远在保留一个已登录会话的情况下测试新配置**。

### 检查清单

```
□ PermitRootLogin no
□ PasswordAuthentication no（且已验证密钥可用）
□ AllowUsers/AllowGroups 限定
□ 22 端口来源受防火墙限制
□ 关闭不必要的转发（按需）
□ MaxAuthTries 3 / LoginGraceTime 30
□ 弱算法已禁（只看 ssh-ed25519 / aes-gcm）
□ ClientAliveInterval 已设
□ LogLevel VERBOSE
□ 关键机器有双因素
□ authorized_keys 有 from/command 限制
□ 密钥集中管理 + 离职移除
□ 改配置先 sshd -T 验证 + 保留会话测试
```
