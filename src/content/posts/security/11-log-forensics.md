---
title: 日志取证：从日志判断"是不是被入侵了"
description: 该看哪些日志、五个高频入侵信号、时间线怎么拼、日志被清空后还能查什么，以及"误报"的常见来源。
date: 2023-06-05
tags: [安全, 取证, 日志, 入侵排查]
---

### 先看哪五类日志

| 日志 | 位置 | 能发现什么 |
| --- | --- | --- |
| 认证日志 | `/var/log/auth.log`、`/var/log/secure` | 爆破、异常登录、sudo |
| 审计日志 | `auditd` / `journalctl -u auditd` | 提权、敏感文件访问、命令执行 |
| Web 访问日志 | nginx/apache | 扫描、注入尝试、webshell 访问 |
| 系统日志 | `journalctl`、`dmesg` | 服务异常、OOM、内核模块加载 |
| 应用日志 | 业务日志 | 异常调用、批量数据导出 |

### 五个高频入侵信号

**① 异常登录成功**

```bash
grep -E 'Accepted|Failed' /var/log/auth.log | tail -50
```

判据：

- 成功登录来自**非常规 IP/国家/时间**。
- 失败后紧接一次成功（爆破成功）。
- 新出现的用户名（尤其 `test`、`admin`、`oracle` 之类）。

```bash
# 统计成功登录的来源 IP
grep 'Accepted' /var/log/auth.log | awk '{print $11}' | sort | uniq -c | sort -rn
```

**② 新增的特权账号 / 密钥**

```bash
awk -F: '$3==0 {print $1}' /etc/passwd          # UID 为 0 的账号
cat /etc/sudoers /etc/sudoers.d/* 2>/dev/null | grep -v '^#'
cat ~/.ssh/authorized_keys
find / -name authorized_keys -newer /etc/passwd 2>/dev/null
```

**③ 可疑进程与网络连接**

```bash
ps -eo pid,ppid,user,etime,cmd --sort=-etime | head -20
ss -antp | grep -E 'ESTAB'
# 外连到非常见端口（如 4444、6666、1080）
ss -antp | awk '$5 !~ /:80|:443|:22/'
```

判据：进程名伪装成 `sshd`/`kworker`，但路径在 `/tmp`、`/dev/shm`。

```bash
ls -l /proc/<pid>/exe        # 真实路径（deleted 说明被删了但还在跑）
```

**④ 定时任务与启动项**

```bash
crontab -l; cat /etc/crontab; ls /etc/cron.*
systemctl list-units --type=service | grep -v 'vendor preset'
ls -la /etc/systemd/system/*.service
cat /etc/rc.local
```

攻击者最常留后门的地方：`/etc/cron.d/`、`/etc/systemd/system/`、`~/.bashrc`、`/etc/ld.so.preload`。

**⑤ 文件被改动的痕迹**

```bash
# 找最近 3 天被修改的可执行文件
find /usr/bin /usr/sbin /bin /sbin -mtime -3 -type f 2>/dev/null | head

# 找 SUID 文件（提权后门常用）
find / -perm -4000 -type f 2>/dev/null | head -20

# 找隐藏文件
find /tmp /dev/shm /var/tmp -type f 2>/dev/null | head
```

### 拼时间线

把多源日志按时间排序，是判断"攻击顺序"的唯一方法。

```bash
{
  grep -h . /var/log/auth.log
  journalctl --since "2026-11-25" -o short-iso
  awk '{print $4, $1, $6, $7}' /var/log/nginx/access.log
} | sort | tail -200
```

格式统一很关键（都用 ISO 时间），否则排序错乱。

### auditd：最有力的证据

```bash
# 关键规则示例
auditctl -w /etc/passwd -p wa -k passwd_change
auditctl -w /etc/sudoers -p wa -k sudoers_change
auditctl -a always,exit -F arch=b64 -S execve -k exec

# 查询
ausearch -k passwd_change -ts today
ausearch -k exec --start today | head
```

`execve` 全量记录开销大，但事故排查时值是"谁在什么时候执行了什么命令"的完整还原。

### 日志被清空后还能查什么

攻击者常做 `echo > /var/log/secure`。仍有可查的：

1. **journalctl 的二进制日志**（`/var/log/journal/`）——文本日志被删，系统日志还在。
2. **远端日志**（如果配了 rsyslog 转发，本地清了远端还有）。
3. **auditd**（独立于 syslog）。
4. **文件系统的 mtime/ctime**（找"最近被改过"的文件）。
5. **进程内存与 `/proc`**（还在运行的恶意进程）。

这就是为什么**日志必须远端集中存储**：本地日志的价值在"入侵后"接近于零。

### 误报的常见来源

| 现象 | 可能是正常 |
| --- | --- |
| 大量 Failed password | 内部扫描器、健康检查、错误配置的监控 |
| 陌生 IP 登录成功 | 员工出差/VPN 出口 |
| 新 SUID 文件 | 新装的软件包（核对包管理器记录） |
| 外连到 4444 | 某些合法服务也用这个端口 |

核实方法：

```bash
# 包管理器能解释的改动通常是正常安装
rpm -qf /usr/bin/xxx       # RHEL
dpkg -S /usr/bin/xxx       # Debian
```

**无法被包管理器解释的可执行文件**，才是重点怀疑对象。

### 处置顺序（不要边查边破坏）

```
① 隔离网络（拔网线/安全组封禁），但保留访问（跳板机）
② 保全证据：内存 dump、磁盘快照、日志导出
③ 分析（在副本上做，不要在原机操作）
④ 清理与恢复（重装优于清理）
⑤ 轮换所有凭据
```

"先删恶意文件再查"是最常见的错误——会把线索一起删掉。

### 检查清单

```
□ 有远端集中日志（本地被清也能查）
□ auditd 关键规则已开
□ 有"成功登录"的告警（不只是失败）
□ 有基线（正常进程/端口/账号清单），才能发现异常
□ 有应急联系人清单与取证流程
```
