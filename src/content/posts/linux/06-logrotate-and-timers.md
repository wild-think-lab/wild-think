---
title: logrotate 与 systemd timer：定时任务的两件正事
description: 日志不切割迟早撑爆磁盘，cron 不可靠时会静默失败。讲清 logrotate 的配置陷阱、systemd timer 的优势，以及两者的组合方案。
date: 2022-02-01
tags: [Linux, logrotate, systemd, 定时任务, 日志]
---

### 两个最常见的"慢性故障"

**第一种**：磁盘满。查下去 `/var/log` 十几 GB，某个服务的日志从上线起就没切过。

**第二种**：定时任务不执行。`crontab` 里有条目，但没跑、没报错、没人知道。

这两件事都不会立刻炸，但都会在半年后的某个夜里炸。

### logrotate 怎么真正生效

配置 `/etc/logrotate.d/myapp`：

```
/var/log/myapp/*.log {
    daily
    rotate 14
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    dateext
    create 0640 app app
    postrotate
        systemctl reload myapp 2>/dev/null || true
    endscript
}
```

逐条解释其中四条最容易出错的：

- `copytruncate`：复制后清空原文件。适合不能重开文件的程序（很多 Java/Python 服务）；缺点是切割瞬间可能丢几行日志。**能 reload 的服务就别用 copytruncate**，用 `postrotate` 让进程重开文件更干净。
- `delaycompress`：本次不压缩，下次才压。避免正在写的文件被压缩导致句柄失效。
- `missingok` + `notifempty`：日志不存在不报错，空文件不切。便于统一模板复用。
- `create 0640 app app`：切完新文件的属主。**忘了这行，新文件变成 root 所有，服务立刻写不进去**——这是最高频的 logrotate 事故。

测试（必须做，别等凌晨 3 点）：

```bash
sudo logrotate -d /etc/logrotate.d/myapp     # dry run，只打印不执行
sudo logrotate -f /etc/logrotate.d/myapp     # 强制切一次，验证权限与 reload
ls -l /var/log/myapp/
```

`-d` 会打印"是否会轮转、执行什么命令"，比猜快得多。

系统自带的调度在 `/etc/cron.daily/logrotate`，注意有些发行版用 `systemd-timer`（`logrotate.timer`）驱动。两者只应存在一个，重复会导致一天切两次。

### cron 为什么不可靠

`crontab -e` 写：

```
0 3 * * * /opt/scripts/backup.sh
```

三个典型问题：

1. **环境变量不同**。cron 的 PATH 极短，脚本里用了 `docker`、`python3` 就找不到。
2. **没有输出记录**。失败信息发到 mail，而机器没配 MTA，直接丢弃。
3. **没有并发保护**。上一次没跑完，下一次又启动，两个备份进程互相踩。

修法：

```
0 3 * * * /usr/bin/flock -n /var/lock/backup.lock /opt/scripts/backup.sh >> /var/log/backup.log 2>&1
```

`flock -n` 是并发锁，`>>` 收集输出，脚本里再显式设 `PATH`。这三件做完，cron 才勉强可运维。

### systemd timer：更现代的做法

`/etc/systemd/system/backup.service`：

```ini
[Unit]
Description=Nightly backup

[Service]
Type=oneshot
ExecStart=/opt/scripts/backup.sh
User=backup
Environment=PATH=/usr/local/bin:/usr/bin:/bin
```

`/etc/systemd/system/backup.timer`：

```ini
[Unit]
Description=Run backup nightly

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now backup.timer
systemctl list-timers --all      # 看下次触发时间
journalctl -u backup.service -n 50 --no-pager
```

比 cron 强的四点：

- `Persistent=true`：关机错过的任务，开机后补跑。
- `RandomizedDelaySec`：多台机器错峰，避免同时打库。
- 输出自动进 journal，不用自己重定向。
- 失败可配 `OnFailure=` 触发告警单元。

### 组合方案

- 日志切割：logrotate（成熟，别自己写脚本删日志）。
- 业务定时任务：systemd timer（可观测、可补跑）。
- 已有 cron 遗产：加 `flock` + 重定向 + 显式 PATH，逐步迁移。

### 检查清单

```bash
# 日志是否在切割
ls -lt /var/log/myapp/ | head
# 定时任务是否真的在跑
systemctl list-timers --all | head -20
crontab -l
grep -r . /etc/cron.d/ 2>/dev/null | head
# 磁盘余量
df -h | awk '$5+0>80'
```

最后一条建议：**给所有定时任务加"心跳"**——成功时写一行带时间戳的日志，监控检查"最近 26 小时内是否有心跳"。没有心跳就是失败，这比"任务没跑但没人发现"强太多。
