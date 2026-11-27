---
title: Linux 服务器基线加固清单：从账号到内核的十二项检查
description: 加固不是跑一个脚本就结束。按"账号—权限—服务—网络—日志—内核"六组顺序做，每项都给出验证命令与回滚方式。
date: 2026-11-19
tags: [安全, Linux, 基线加固, 等保, 加固]
---

基线加固的价值不在于"配置看起来更严格"，而在于**每一条都能被验证、被回滚、被审计**。下面十二项按组排列，每项给出检查与验证命令。

## 一、账号与认证

**1. 清理无用账号与空口令**

```bash
# 找出 UID 为 0 的非 root 账号（重点）
awk -F: '($3==0){print $1}' /etc/passwd
# 找出带 shell 的系统账号
awk -F: '($3<1000 && $7!~/nologin|false/){print $1,$7}' /etc/passwd
# 空口令检查
awk -F: '($2==""){print $1}' /etc/shadow
```

**2. 口令策略与登录限制**

`/etc/login.defs` 控制新建用户的口令时效；`/etc/security/pwquality.conf` 控制复杂度。历史口令与失败锁定用 PAM：

```conf
# /etc/pam.d/system-auth 增加
auth        required      pam_faillock.so preauth silent deny=5 unlock_time=900
auth        sufficient    pam_unix.so
account     required      pam_faillock.so
```

验证：故意输错 5 次，观察锁定与解锁时间是否与配置一致（不要在生产机上直接试，用测试账号）。

**3. SSH 最小暴露面**

```conf
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
ClientAliveInterval 300
AllowUsers deploy ops
```

改完先 `sshd -t` 校验语法，**保留一个已登录会话**再 `systemctl reload sshd`——否则配置写错会把自己锁在门外。

## 二、权限与文件完整性

**4. 关键文件权限**

| 文件 | 建议权限 | 说明 |
| --- | --- | --- |
| `/etc/passwd` | 644 | 可读不可写 |
| `/etc/shadow` | 600 或 000（root 可读） | 哈希严禁可读 |
| `/etc/ssh/sshd_config` | 600 | 配置可被篡改等于接管 |
| `/etc/crontab`、`/etc/cron.*` | 600 | 定时任务是最常见持久化点 |
| 用户家目录 | 750 或 700 | 防止横向读取 |

```bash
ls -l /etc/shadow /etc/sshd_config /etc/crontab 2>/dev/null
```

**5. SUID/SGID 收敛**

```bash
sudo find / -xdev -perm -4000 -type f -ls 2>/dev/null
sudo find / -xdev -perm -2000 -type f -ls 2>/dev/null
```

对照发行版基线清单，把非必要的 SUID 位清掉（如 `chmod u-s`）。特别注意自编译安装带进来的二进制。

**6. 不可变属性保护关键配置**

```bash
sudo chattr +i /etc/passwd /etc/shadow /boot/grub2/grub.cfg
lsattr /etc/shadow      # 应看到 i
```

注意：`chattr +i` 会连合法的用户管理操作一起挡住，需要变更时先 `-i`，改完再加。**不要**在没有变更流程的情况下对 `/etc` 全目录加锁。

## 三、服务与端口

**7. 关闭不必要服务、绑定回环**

```bash
ss -lntup                      # 实际监听
systemctl list-unit-files --state=enabled   # 开机自启
```

数据库、缓存、管理面板一律只绑 `127.0.0.1` 或内网地址。Redis 的 `bind 0.0.0.0` + 无密码是历史上被扫得最狠的组合。

**8. 文件共享与远程管理**

SMB/NFS 只对必要网段开放，导出目录加 `root_squash`；管理面（SSH、面板）走堡垒机或内网跳板，公网只留业务端口。

## 四、网络与访问控制

**9. 主机防火墙默认拒绝**

```bash
# firewalld
firewall-cmd --set-default-zone=drop
firewall-cmd --permanent --add-service=ssh
firewall-cmd --reload
firewall-cmd --list-all

# 或 iptables/nftables 显式白名单
```

**关键**：先放行管理端口再切默认策略。顺序错了就是远程失联。

**10. 内核网络参数**

```conf
# /etc/sysctl.d/99-hardening.conf
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
```

`sysctl --system` 生效，`sysctl -a | grep <key>` 逐条验证。`dmesg_restrict` 会让普通用户看不到内核日志，排障时要记得这一点。

## 五、日志与审计

**11. 审计规则与日志留存**

```bash
# auditd 关键规则
auditctl -w /etc/passwd -p wa -k passwd_change
auditctl -w /etc/shadow -p wa -k shadow_change
auditctl -a always,exit -F arch=b64 -S execve -k exec

# 持久化写入 /etc/audit/rules.d/hardening.rules
augenrules --load
auditctl -l
```

日志集中到远端（rsyslog/syslog-ng），本地留存 ≥ 6 个月，满足等保三级的基本要求。本地日志被清是入侵后的典型动作，远端留一份才有取证价值。

## 六、补丁与时间

**12. 补丁与时间同步**

```bash
# 只列安全更新，避免盲目全量升级
yum updateinfo list security
dnf updateinfo list security
# 时间同步
timedatectl status
chronyc sources -v
```

时间不同步会让日志时间线错乱，跨主机关联分析失效——这不是小事。

## 加固后的验证方式

1. **对内**：逐项跑上面的验证命令，输出存成基线快照，纳入版本管理。
2. **对外**：从另一台机器用 `nc -zv` 扫监听端口，确认暴露面符合预期。
3. **回归**：重启一次，确认 `sysctl`、`chattr`、`systemd` 状态都持久化（很多加固"生效一次就没了"）。
4. **可回滚**：每项改动记录原始值，形成回滚脚本。

> 一条底线：**任何加固动作之前，先确认自己还有另一条能进机器的路径**（控制台、KVM、另一条 SSH 会话）。这是所有生产变更的通用规则。
