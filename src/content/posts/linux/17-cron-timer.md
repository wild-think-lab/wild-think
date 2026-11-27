---
title: 定时任务：cron 与 systemd timer 怎么选
description: cron 的五个坑、systemd timer 的优势、随机延迟与错峰、以及"任务没跑"的排查顺序。
date: 2024-11-04
tags: [Linux, cron, systemd]
---

### 先说结论

```
简单周期任务、单机脚本 → cron（够用、简单）
需要日志/依赖/错峰/失败重试 → systemd timer（更现代）
```

**"cron 用得好不好"往往决定"半夜有没有人被打起来"**。

### cron 的五个坑

**① 环境变量极简**

```
cron 的 PATH 只有 /usr/bin:/bin
→ 脚本里用到的 /usr/local/bin 下的命令找不到
```

**修复**：

```bash
#!/usr/bin/env bash
PATH=/usr/local/bin:/usr/bin:/bin
set -euo pipefail
```

**或者**在 crontab 顶部显式设置：

```
PATH=/usr/local/bin:/usr/bin:/bin
SHELL=/bin/bash
```

**② 相对路径全错**

```
cron 的工作目录是用户 home
→ 脚本里 cd /opt/app 必须显式写
```

**③ 输出会发邮件（本地邮件堆积）**

```
默认输出发给 root 的本地邮箱
→ /var/mail 越积越大，或干脆没人看
```

**修复**：

```
把输出重定向到日志文件：>> /var/log/job.log 2>&1
或者 MAILTO="" 关掉邮件
```

**④ 时间语义容易看错**

```
0 2 * * *    每天 02:00
*/5 * * * *  每 5 分钟
0 2 * * 1-5  周一到周五 02:00
0 2 1 * *    每月 1 日 02:00
```

**注意"每周日"是 0 或 7**。

**⑤ 没有"错过执行"的补偿**

```
机器在 02:00 关机 → 这个任务就跳过了（不会补跑）
```

**systemd timer 有 `Persistent=true`**：

```
错过的任务在开机后补跑一次
```

### systemd timer 的优势

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Daily backup

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=600       # 随机延迟 0–10 分钟（错峰）
Persistent=true              # 错过就补跑

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/backup.service
[Unit]
Description=Backup job

[Service]
Type=oneshot
User=ops
WorkingDirectory=/opt/backup
ExecStart=/opt/backup/run.sh
StandardOutput=journal
StandardError=journal
```

**比 cron 强的五点**：

```
① 日志走 journalctl（统一收集）
② 有依赖（After/Requires）
③ 有 Persistent（补跑）
④ 有 RandomizedDelay（错峰）
⑤ 有资源限制（CPUQuota/MemoryMax）
```

**"RandomizedDelaySec 是错峰的关键"**：

```
100 台机器都在 02:00 跑备份 → 存储瞬间被打满
加 10 分钟随机延迟 → 压力摊平
```

### 常用 OnCalendar 语法

```
daily                    每天 00:00
weekly                   每周一 00:00
*-*-* 02:30:00           每天 02:30
Mon-Fri 09:00            工作日 09:00
*-*-01 03:00             每月 1 日 03:00
every 15min              每 15 分钟
```

**验证**：

```bash
systemd-analyze calendar "Mon-Fri 09:00"
# 会显示"下次触发时间"，非常有用
```

### 排查"任务没跑"

**cron**：

```bash
# 1. 是否被加载
crontab -l
systemctl status cron        # 或 crond

# 2. 日志
grep CRON /var/log/syslog    # Debian 系
journalctl -u cron --since -1h

# 3. 手动跑一次（模拟 cron 环境）
env -i PATH=/usr/bin:/bin /bin/bash /path/script.sh
```

**"手动能跑，cron 不跑"** 基本都是环境变量/路径/权限问题。

**systemd timer**：

```bash
systemctl list-timers                 # 看下次触发与上次触发
systemctl status backup.timer
journalctl -u backup.service -n 50
systemd-analyze verify /etc/systemd/system/backup.timer
```

**`list-timers` 直接显示"NEXT/LEFT/LAST"**，一眼看出是否正常。

### 五个"能跑但产出不对"的原因

```
① 工作目录不对（写到了 home 而不是目标目录）
② 时区不对（容器里是 UTC，宿主机是 UTC+8）
③ 并发运行（上一次没跑完，这次又起来）
④ 磁盘满（脚本"成功"但写不进去）
⑤ 权限变了（脚本能跑但读不到文件）
```

**并发运行的解法**：

```
cron：用 flock
*/5 * * * * flock -n /var/lock/job.lock /opt/script.sh
```

```
systemd：默认不并发（同 unit 不会重复启动）
```

**`flock -n` 的意义**：拿不到锁就跳过（不排队堆积）。

### 一个"可靠"的备份 cron

```bash
#!/usr/bin/env bash
set -euo pipefail
PATH=/usr/local/bin:/usr/bin:/bin
IFS=$'\n\t'

LOG=/var/log/backup.log
exec >> "$LOG" 2>&1
echo "=== $(date +%F' '%T) start ==="

flock -n /var/lock/backup.lock || { echo "already running"; exit 0; }

/opt/backup/dump.sh
rc=$?
echo "=== $(date +%F' '%T) done rc=$rc ==="
exit $rc
```

**要点**：

```
① 显式 PATH + 严格模式
② 输出重定向到日志（不依赖邮件）
③ flock 防并发
④ 有开始/结束标记（便于判断"是否卡住"）
```

### 检查清单

```
□ cron 里显式设 PATH 与 SHELL
□ 脚本里用绝对路径
□ 输出去日志文件（或关掉 MAILTO）
□ 用 flock 防并发
□ 时区确认（容器场景尤其）
□ 需要"错过补跑"就用 systemd timer
□ 批量机器用 RandomizedDelaySec 错峰
□ 有开始/结束日志标记
□ 排查顺序：是否加载 → 日志 → 手动模拟环境
□ systemctl list-timers 定期巡一遍
```
