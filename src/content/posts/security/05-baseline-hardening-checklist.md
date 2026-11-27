---
title: 安全基线加固：从"能跑"到"能过检查"
description: Linux 与 Windows 主机的 20 项基线检查：账号、SSH、防火墙、SELinux、日志审计、补丁与文件权限，附一键自查脚本思路。
date: 2026-11-27
tags: [安全, 加固, 基线, 等保, SSH]
---

### 基线是什么

基线就是**"这套系统上线前必须满足的最小安全状态"**。它不是高级技能，而是清单：

- 不许有弱口令、空口令。
- 不许 root 直接远程登录。
- 不许防火墙全关。
- 必须有日志，且日志留够时间。
- 补丁必须打。

等保二级/三级检查，80% 的问题都在这些"看起来很简单"的地方。

### 账号与权限

```bash
# 空口令账号
awk -F: '($2==""){print $1}' /etc/shadow

# UID 为 0 的非 root 账号（后门高危）
awk -F: '($3==0){print $1}' /etc/passwd

# 可登录 shell 的账号清单
grep -v '/sbin/nologin\|/bin/false' /etc/passwd

# sudo 权限过大
grep -r 'NOPASSWD' /etc/sudoers /etc/sudoers.d/
```

处置：

- 删除无用账号（`userdel -r` 前先确认没有进程在用）。
- `NOPASSWD:ALL` 必须收敛到具体命令。
- 口令策略写进 `/etc/security/pwquality.conf`：最小长度 8、含三类字符、历史 5 次。

### SSH 加固（收益最高的一步）

```ini
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no          # 只允许公钥
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers ops deploy              # 白名单
Protocol 2
```

```bash
sudo sshd -t           # 改完先测语法，否则重启失败会把自己锁在外面
sudo systemctl reload sshd
```

**务必先确认另一个会话能登录再 reload**。这是最常见把自己锁在门外的方式。

### 防火墙与端口最小化

```bash
ss -tulnp | sort -k4            # 看谁在监听
sudo firewall-cmd --list-all
sudo ufw status verbose
```

原则：只开业务端口 + 管理端口（且管理端口限制来源 IP）。

```bash
# 只允许内网访问 22
sudo ufw allow from 10.10.10.0/24 to any port 22
sudo ufw default deny incoming
sudo ufw enable
```

### SELinux / AppArmor

```bash
getenforce                       # 应为 Enforcing
sestatus
aa-status                        # Ubuntu 系
```

要临时排查可以 `setenforce 0`，但**不允许长期停留在 Permissive**，那等于没开。

### 日志与审计

```bash
sudo systemctl status auditd
sudo auditctl -l
```

最小要求：

- `auditd` 开启，记录 `execve`、账号变更、权限变更。
- 日志集中到一台日志服务器（rsyslog/journald 转发），本地被清也不影响取证。
- 保留 180 天（等保三级要求 6 个月）。

```bash
# 关键审计规则
-w /etc/passwd -p wa -k user_modify
-w /etc/shadow -p wa -k shadow_modify
-w /etc/sudoers -p wa -k sudoers
-a always,exit -F arch=b64 -S execve -k cmd_exec
```

### 补丁与内核参数

```bash
# 补丁
sudo yum update --security -y        # RHEL/CentOS
sudo unattended-upgrade -d           # Debian 系
uname -r                             # 内核版本是否过旧

# 内核加固（/etc/sysctl.d/99-hardening.conf）
kernel.randomize_va_space = 2
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.ip_forward = 0              # 非路由器不要开
fs.suid_dumpable = 0
```

```bash
sudo sysctl --system
```

### 文件权限与危险文件

```bash
# 全局可写的目录/文件
find / -xdev -type d -perm -0002 -print 2>/dev/null
find / -xdev -type f -perm -0002 -print 2>/dev/null

# 无主文件
find / -xdev \( -nouser -o -nogroup \) -print 2>/dev/null

# SUID 文件清单（对照白名单）
find / -xdev -perm -4000 -type f -print 2>/dev/null
```

`/tmp` 单独分区 + `nosuid,noexec,nodev` 挂载，能挡掉一批提权手法。

### Windows 侧对应项

```powershell
# 本地管理员组成员
Get-LocalGroupMember -Group Administrators

# 缺省共享
Get-SmbShare

# 防火墙状态
Get-NetFirewallProfile | Select Name, Enabled

# 补丁与更新
Get-HotFix | Sort InstalledOn -Descending | Select -First 5
Get-Service wuauserv | Select Status

# 远程桌面是否只允许 NLA
Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication
```

要点的四条：管理员组只留必要账号、关闭 `C$`/`ADMIN$` 之外的无用共享、RDP 强制 NLA 且限制来源、开启审核策略（登录事件、对象访问）。

### 一键自查脚本思路

不要手抄命令，写脚本：

```bash
#!/usr/bin/env bash
set -uo pipefail
report=/var/log/baseline-$(hostname)-$(date +%F).txt
{
  echo "## 空口令";        awk -F: '($2==""){print $1}' /etc/shadow
  echo "## UID0";          awk -F: '($3==0){print $1}' /etc/passwd
  echo "## root 远程";     grep -E '^PermitRootLogin' /etc/ssh/sshd_config
  echo "## 密码登录";      grep -E '^PasswordAuthentication' /etc/ssh/sshd_config
  echo "## SELinux";       getenforce 2>/dev/null
  echo "## 防火墙";        (firewall-cmd --state || ufw status) 2>/dev/null
  echo "## 审计";          systemctl is-active auditd
  echo "## 监听端口";      ss -tulnp
  echo "## 全局可写";      find / -xdev -type d -perm -0002 -print 2>/dev/null | head -20
} > "$report" 2>&1
echo "报告: $report"
```

跑完拿报告对照清单，逐条修，修完再跑一次直到全绿。这就是"加固"的全部流程。

### 加固的顺序（按风险收益）

1. SSH 禁止 root + 只允许公钥。
2. 防火墙最小开放。
3. 账号清理 + sudo 收敛。
4. 补丁。
5. 日志与审计。
6. 文件权限与内核参数。
7. 定期复查（每月一次脚本比对）。

加固不是一次性任务，是**持续对照清单**。没人复查的基线，三个月后就回到加固前的样子。
