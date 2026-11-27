---
title: Linux 加固速查
summary: SSH、权限、审计、防火墙与内核的十二条加固动作，每条配验证命令。
group: security
order: 1
tags: [Linux, 安全, 加固]
---

### SSH

```bash
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config
sed -i 's/^#*ClientAliveInterval.*/ClientAliveInterval 300/' /etc/ssh/sshd_config
sshd -t && systemctl reload sshd
sshd -T | grep -E "permitrootlogin|passwordauthentication"
```

### 账号与 sudo

```bash
awk -F: '$7 !~ /nologin|false/ {print $1, $7}' /etc/passwd
grep -r "ALL" /etc/sudoers /etc/sudoers.d/ 2>/dev/null
usermod -L <user>            # 锁定
```

### 审计

```bash
systemctl status auditd
auditctl -l
# 关键目录监控
auditctl -w /etc/passwd -p wa -k passwd_change
auditctl -w /etc/sudoers -p wa -k sudoers_change
```

**"审计日志要集中且不可删"**（转发到日志平台）。

### 权限

```bash
find / -perm -4000 -type f 2>/dev/null       # SUID
find / -perm -0002 -type f 2>/dev/null       # 全局可写文件
ls -l /etc/shadow /etc/passwd
```

### 防火墙

```bash
firewall-cmd --set-default-zone=drop
firewall-cmd --permanent --add-service=ssh
firewall-cmd --reload
firewall-cmd --list-all
ss -lntp                                     # 确认只监听必要端口
```

### 内核与网络

```bash
sysctl -w net.ipv4.ip_forward=0               # 不需要就不开
sysctl -w net.ipv4.conf.all.accept_redirects=0
sysctl -w net.ipv4.conf.all.send_redirects=0
sysctl -w kernel.randomize_va_space=2
```

### SELinux

```bash
getenforce
sestatus
# 不要 Disabled，用 enforcing 或 permissive 并修配置
```

### 补丁

```bash
dnf updateinfo list security
dnf update --security
```

### 时间

```bash
timedatectl
chronyc sources -v
```

### 日志与审计留存

```bash
ls /var/log
journalctl --disk-usage
# 确认转发到集中平台
```

### 十二条清单

```
□ SSH 禁 root 密码登录
□ MaxAuthTries 限制
□ 无用账号禁用/删除
□ sudo 最小化
□ auditd 运行 + 关键目录监控
□ SUID 与全局可写文件已检查
□ 防火墙默认拒绝
□ 只监听必要端口
□ 不需要转发则关 ip_forward
□ SELinux 未 Disabled
□ 安全补丁已打
□ 时间同步正常
```

### 验证一次

```bash
sshd -T | grep -E "permitrootlogin|passwordauthentication"
getenforce
firewall-cmd --list-all
ss -lntp
```
