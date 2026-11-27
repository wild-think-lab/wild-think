---
title: systemd timer 还是 cron：定时任务该怎么选
description: 两者的差异、timer 的写法与校验、五个"任务没跑"的排查点。
date: 2026-01-15
tags: [Linux, 运维, 定时任务]
---

### 先看差异

```
cron      ：分钟级、按用户、日志少、没有状态
systemd   ：秒级、有依赖、有日志、可持久化错过任务
```

**"错过一次要不要补"** 是选择的关键（`Persistent=true` 能补）。

### 一个 timer 的最小写法

```ini
# /etc/systemd/system/backup.service
[Unit]
Description=Daily backup

[Service]
Type=oneshot
User=backup
ExecStart=/opt/backup/run.sh
```

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Run backup daily

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now backup.timer
systemctl list-timers --all
systemctl status backup.timer
```

**`Persistent=true`** 的意义：关机期间错过的任务，开机后补跑一次。

### OnCalendar 语法（容易写错）

```
*-*-* 02:30:00        每天 02:30
Mon..Fri 09:00        工作日 9 点
*-*-01 03:00          每月 1 号
hourly                每小时
```

```bash
systemd-analyze calendar "*-*-* 02:30:00"
# 会打印下次触发时间 —— 写错了立刻发现
```

### 五个"任务没跑"

**① 没 enable**

```
只 start 了 timer 没 enable → 重启后没了
```

**② ExecStart 路径/权限不对**

```
User=backup 但脚本读不到配置
→ journalctl -u backup.service 看错误
```

**③ timer 与 service 名字不匹配**

```
backup.timer 要对应 backup.service（同名前缀）
```

**④ OnCalendar 时区**

```
systemd 用系统时区；容器里可能是 UTC
```

**⑤ 上次没跑完，本次被跳过**

```
同一个 timer 不会并发执行（要手动处理重叠）
```

### 日志与告警

```bash
journalctl -u backup.service --since "2 days ago"
systemctl show backup.service -p Result -p ExecMainStatus
```

**判据**：

```
Result=success 且 ExecMainStatus=0 → 成功
```

**"cron 邮件没人看"** → 改用 systemd + 把 Result 上报到监控。

### 一个"能上生产"的定时任务模板

```ini
[Service]
Type=oneshot
User=app
WorkingDirectory=/opt/app
ExecStart=/opt/app/job.sh
TimeoutStartSec=30min
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
StandardOutput=journal
StandardError=journal
```

```ini
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
AccuracySec=1m
RandomizedDelaySec=15m
Unit=app-job.service
```

**`RandomizedDelaySec`** 防止"全机同一秒启动"（集群里尤其重要）。

### cron 什么时候仍然更合适

```
① 很简单的"每 5 分钟跑一次"
② 老系统/容器镜像里不想装 systemd
③ 需要"按用户 crontab"分散管理
```

**"容器里用 cron"** 很常见，但要自己处理日志与错过任务。

### 检查清单

```
□ 名字同前缀（xxx.timer / xxx.service）
□ 已 enable（重启后仍在）
□ OnCalendar 用 systemd-analyze 校验
□ Persistent 按需设置
□ 有 RandomizedDelaySec（集群场景）
□ 有超时（TimeoutStartSec）
□ 有 Result 监控告警
□ 时区正确
□ 重叠执行有策略
□ 有"补跑"机制或明确接受不补
```
