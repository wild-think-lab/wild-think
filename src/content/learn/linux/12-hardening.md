---
title: 主机安全加固：从能用到敢放公网
module: 熟练篇
summary: SSH 加固、账号与 sudo、防火墙默认拒绝、SELinux、补丁与审计,以及五个"加固后把自己锁在外面"的坑。
minutes: 50
---

### 加固的顺序（先保命再收紧）

```
① 备份配置 + 保留一个可用会话
② 账号与 SSH
③ 防火墙
④ 服务最小化
⑤ 补丁与审计
⑥ 定期复核
```

**"先关 SSH 密码登录再测密钥"** → 直接把自己锁在外面。

### SSH 加固

```conf
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
ClientAliveInterval 300
AllowUsers deploy
```

```bash
sshd -t && systemctl reload sshd
```

**验证顺序**：

```
① 先确认密钥能登录（开一个新会话测）
② 再改配置
③ reload 后"不要退出当前会话"，另开一个验证
④ 都正常再退出
```

### 账号与 sudo

```bash
# 禁止空密码账号
awk -F: '($2==""){print $1}' /etc/shadow

# 只允许 wheel 组 sudo
visudo
# %wheel ALL=(ALL) ALL
```

**"所有人都是 root"** → 审计日志失去意义。

### 防火墙：默认拒绝

```bash
firewall-cmd --set-default-zone=drop
firewall-cmd --permanent --add-service=ssh
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
firewall-cmd --list-all
```

**"先 drop 再加规则"** 会断掉当前 SSH（除非先放行 22）。

### SELinux / AppArmor

```bash
getenforce                 # Enforcing / Permissive
sestatus
# 排障时先看审计
ausearch -m avc -ts recent
```

**建议**：不要图省事 `setenforce 0`，用 `semanage`/`setsebool` 精确放行。

### 服务最小化

```bash
ss -lntp                       # 有哪些在听
systemctl list-unit-files --state=enabled
```

**"装完系统就开一堆服务"** → 每个都是潜在入口。

### 补丁策略

```
① 只装安全更新（自动）
② 内核更新要重启（安排窗口）
③ 有"回滚内核"的准备（保留旧内核）
④ 有补丁影响评估（不是无脑上）
```

```bash
# Debian/Ubuntu
unattended-upgrade --dry-run
# RHEL 系
dnf updateinfo list security
```

### 审计与检测

```bash
# 登录记录
last -n 20; lastb -n 20
# 审计规则（auditd）
auditctl -l
# 关键文件完整性（aide/tripwire）
```

**"被登录了不知道"** → 至少要监控"异常来源的成功登录"。

### 五个"加固后把自己锁在外面"

```
① 改 sshd 前没测密钥
② 防火墙先 drop 没放行 22
③ 改了 sudoers 语法错 → sudo 全废（用 visudo 校验）
④ SELinux 改了上下文导致服务起不来（先 Permissive 验证）
⑤ PermitRootLogin no 但只有 root 有密钥
```

### 检查清单

```
□ root 禁止密码登录
□ 只允许密钥
□ 有非 root 运维账号 + sudo
□ 防火墙默认拒绝 + 只放行必要
□ SELinux/AppArmor 处于 Enforcing
□ 关闭无用服务
□ 安全更新自动/定期
□ 有审计（登录 + 关键文件）
□ 有"加固前备份与回滚"步骤
□ 每次加固都留一个可用会话
```
