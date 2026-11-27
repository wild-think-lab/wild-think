---
title: 定时任务与开机自启：让事情自己发生
module: 熟练篇
summary: cron 写法的五个坑、systemd timer 更可靠的替代、开机自启的三种方式与验证。
minutes: 40
---

### cron 的最小写法

```bash
crontab -e
# 分 时 日 月 周
30 2 * * * /opt/backup/run.sh >> /var/log/backup.log 2>&1
```

**五个坑**：

```
① 环境变量不同（PATH 少 → 命令找不到）
② 工作目录不是你想的那个（cd 要显式写）
③ 没有输出重定向 → 默默失败
④ % 需要转义（crontab 里 % 是换行）
⑤ 任务重叠（上一轮没跑完下一轮又起）
```

**"脚本手动能跑，cron 不行"** → 十有八九是 PATH 与工作目录。

### 一个"能上生产"的 cron 条目

```bash
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""

*/5 * * * * cd /opt/app && flock -n /var/lock/app.lock ./job.sh >> /var/log/app-job.log 2>&1
```

**`flock -n`** 防止重叠（拿不到锁就直接跳过这一轮）。

### systemd timer：更可靠的替代

```ini
# /etc/systemd/system/app-job.service
[Unit]
Description=App job

[Service]
Type=oneshot
User=app
WorkingDirectory=/opt/app
ExecStart=/opt/app/job.sh
TimeoutStartSec=30min
```

```ini
# /etc/systemd/system/app-job.timer
[Unit]
Description=Run app job every 5 min

[Timer]
OnCalendar=*:0/5
Persistent=true
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now app-job.timer
systemctl list-timers --all
journalctl -u app-job.service -n 50
```

**优势**：有日志、有结果状态（`Result=success`）、能补跑（`Persistent=true`）。

### OnCalendar 语法

```
*-*-* 02:30:00      每天 02:30
Mon..Fri 09:00      工作日
*:0/5               每 5 分钟
```

```bash
systemd-analyze calendar "*:0/5"
```

**"写错就没人跑"** → 一定用 `systemd-analyze` 验证。

### 开机自启的三种方式

```
① systemd service（enable）
② cron @reboot
③ rc.local / 云厂商 user-data
```

```bash
systemctl enable nginx
systemctl is-enabled nginx
```

**"重启后服务没起"** → 检查 `enable` 与 service 的 `[Install]` 段。

### 依赖顺序（别用 sleep 凑）

```ini
[Unit]
After=network-online.target postgresql.service
Wants=network-online.target
```

**"用 sleep 30 等数据库"** 是典型的坏实践（机器慢就崩）。

### 验证自启（最重要）

```
① 重启一次
② systemctl is-active 目标服务
③ 业务探针（curl 健康接口）
④ 日志里确认启动时间
```

**"以为配了"** 和"真的起了"之间，差一次重启验证。

### 检查清单

```
□ cron 条目有 PATH 与工作目录
□ 有输出重定向
□ 有 flock 防重叠
□ 关键任务改用 systemd timer
□ timer 用 systemd-analyze 验证过
□ 开机自启已 enable
□ 有依赖顺序（不是 sleep）
□ 有"重启后验证"的固定流程
□ 任务失败有告警（不是只写日志）
□ 有补跑策略（Persistent 或明确接受不补）
```
