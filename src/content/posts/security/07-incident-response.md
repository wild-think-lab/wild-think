---
title: 入侵排查：机器被拿下之后的前两小时
description: 发现异常后先做什么、保全什么、查什么：账号与计划任务、进程与网络、持久化位置、日志与时间线，最后如何止损与复盘。
date: 2026-11-27
tags: [安全, 应急响应, 入侵排查, 日志]
---

### 第一原则：先保全，再清理

发现"机器可能被入侵"时，最常见的错误是**先动手删文件、杀进程**。这会把证据毁掉，导致后面无法判断影响范围。

前十分钟要做的三件事：

1. **隔离网络**（拔网线或切安全组），但不要关机——内存里有进程、网络连接、可能的无文件木马。
2. **留证据**：导出关键命令输出到独立介质（U 盘或其他机器），不要存在本机。
3. **不要重启**。重启会清掉内存证据，也会触发攻击者留下的"重启后门"。

### 快速判断是"真入侵"还是"误报"

把下面这几项一起看，比任何单一指标都准：

```bash
# 1. 有没有不认识的高 CPU / 高 IO 进程
ps -eo pid,ppid,user,%cpu,etime,cmd --sort=-%cpu | head -20

# 2. 有没有异常的对外连接（矿池、C2 域名）
ss -tnp | awk '$1=="ESTAB"{print $5}' | cut -d: -f1 | sort | uniq -c | sort -rn | head

# 3. 有没有不认识的监听端口
ss -lntp

# 4. 最近改动的系统文件
find /etc /usr/bin /usr/sbin -newermt '-7 days' -type f -ls

# 5. 是否有新账号 / 提权
awk -F: '$3>=0 {print $1, $3, $7}' /etc/passwd | sort -k2 -n | head -20
grep -v '^#' /etc/sudoers /etc/sudoers.d/* 2>/dev/null
```

判断逻辑：**"高 CPU + 陌生外连 + 陌生监听"同时出现，基本可以认定。** 单独出现高 CPU，先排除业务进程与监控 agent。

### 账号与权限

```bash
# UID 为 0 的非 root 账号（经典后门）
awk -F: '($3==0){print $1}' /etc/passwd

# 有 shell 权限的账号
awk -F: '($7 !~ /nologin|false|sync){print $1,$7}' /etc/passwd

# 最近修改过密码/账号的痕迹
lastlog | head
last -n 30
who

# SSH 授权文件里的陌生公钥
cat /root/.ssh/authorized_keys ~*/.ssh/authorized_keys 2>/dev/null
```

`authorized_keys` 里多出来的 key 是最常见的持久化手段之一，**所有用户的家目录都要查**，不只是 root。

### 持久化：查这八个位置

```bash
# 1. cron
crontab -l; ls -la /etc/cron.* /var/spool/cron/* 2>/dev/null
for u in $(cut -d: -f1 /etc/passwd); do crontab -l -u $u 2>/dev/null | grep -v '^#'; done

# 2. systemd unit（新增或被改过的）
ls -lt /etc/systemd/system/ | head
grep -rl 'curl\|wget\|base64\|/tmp' /etc/systemd/system/*.service 2>/dev/null

# 3. rc.local 与 profile
cat /etc/rc.local 2>/dev/null
tail -20 /etc/profile /etc/bashrc ~/.bashrc ~/.bash_profile 2>/dev/null

# 4. LD_PRELOAD 劫持
grep -r LD_PRELOAD /etc/ld.so.preload /etc/profile.d/ 2>/dev/null

# 5. sshd 后门（配置被改）
grep -E 'PermitRootLogin|PasswordAuthentication|AuthorizedKeysCommand' /etc/ssh/sshd_config

# 6. /etc/passwd 里的异常 shell
# 7. 内核模块
lsmod; cat /proc/modules | head

# 8. 定时器
systemctl list-timers --all
```

`/etc/ld.so.preload` 出现内容几乎一定是被入侵——正常系统这个文件通常为空或不存在。

### 进程与文件

```bash
# 进程的真实可执行文件（防"改名的合法进程"）
ls -l /proc/<pid>/exe
cat /proc/<pid>/cmdline | tr '\0' ' '
ls -l /proc/<pid>/cwd

# 已删除但仍被占用的文件（常见于"删了还在跑"的木马）
lsof +L1 2>/dev/null | head -20

# 全盘找可疑可执行
find /tmp /var/tmp /dev/shm -type f -perm -u+x -ls 2>/dev/null
```

`/tmp`、`/dev/shm`、`/var/tmp` 是可写目录，攻击者最爱往这三个地方放 payload。

### 日志与时间线

```bash
# 登录与提权
journalctl -u sshd --since '-7d' | grep -E 'Accepted|Failed|Invalid'
lastb -n 30
grep -i 'session opened for user root' /var/log/auth.log /var/log/secure 2>/dev/null | tail

# 命令历史（可能被清，但 .bash_history 常有残留）
cat ~/.bash_history | tail -50
find / -name '.bash_history' -newermt '-7d' 2>/dev/null

# Web 侧（如果对外提供服务）
grep -E 'union select|<script|/etc/passwd|\.\./' /var/log/nginx/access.log | tail -50
```

把它们按时间排成一条线，能回答"第一次进来是什么时候、用什么方式、之后做了什么"。

### 木马与挖矿的典型特征

- 进程名伪装成 `kworker`、`sshd`、`[kthreadd]`（注意方括号是内核线程标志，伪装的会没有）。
- CPU 长期 100% 但找不到对应进程（在容器里或用了进程隐藏）。
- 大量 443 出连到陌生域名（矿池通常用 Stratum 协议，端口 3333/5555/7777/14444）。
- `/etc/hosts` 被改，把安全站点解析到 127.0.0.1。

```bash
cat /etc/hosts
grep -c '127.0.0.1' /etc/hosts        # 异常多就要注意
```

### 止损与清理的顺序

1. 阻断：安全组封出向，或直接断网。
2. 保留证据：把上面命令的输出打包，计算哈希。
3. 评估影响：这台机器上有哪些凭据（数据库密码、云 AK/SK、SSH 私钥）。**凭据泄露比机器沦陷更严重**。
4. 重建而非清理：**重装系统 / 换新实例**，把数据从备份恢复（备份要确认未被污染）。
5. 轮换凭据：所有在该机器上出现过的密钥、密码、token 全部作废重发。
6. 复盘：入口是什么（弱口令、开源组件漏洞、暴露的 Redis），补上对应的防护。

**不要试图"清理干净"一台已经被 root 拿下的机器**：内核级后门、被替换的二进制都无法可靠排除。

### 事前该有的东西

- 集中日志（机器被清日志就全没了）。
- 主机入侵检测（auditd 规则 + 文件完整性校验 AIDE）。
- 出向流量白名单（挖矿与 C2 的第一步就是外连）。
- 定期 `last`/`authorized_keys` 基线比对。

### 一句话总结

入侵排查的顺序永远是**保全 → 取证 → 评估 → 重建 → 轮换**，跳步就会把"事件"变成"事故"。
