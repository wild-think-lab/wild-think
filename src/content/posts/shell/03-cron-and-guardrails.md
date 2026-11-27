---
title: 定时任务与危险操作防护：别让脚本在凌晨三点删库
description: cron 的五个时间字段、为什么脚本在 cron 里跑不起来、防并发与防误删的四道锁。
date: 2022-06-01
tags: [Shell, cron, 定时任务, 运维, 安全]
---

### cron 的五个字段

```text
* * * * *  command
│ │ │ │ └── 星期（0-7，0 和 7 都是周日）
│ │ │ └──── 月（1-12）
│ │ └────── 日（1-31）
│ └──────── 小时（0-23）
└────────── 分钟（0-59）
```

常用写法：

| 需求 | 表达式 |
| --- | --- |
| 每 5 分钟 | `*/5 * * * *` |
| 每天 3:10 | `10 3 * * *` |
| 每周一 9:00 | `0 9 * * 1` |
| 每月 1 日 0:30 | `30 0 1 * *` |
| 工作日每 2 小时 | `0 */2 * * 1-5` |

编辑用 `crontab -e`，别直接改 `/var/spool/cron/` 下的文件。

### 为什么"手动能跑，cron 跑不起来"

这是最高频的定时任务问题，原因几乎固定：

1. **环境变量不同**：cron 的 `PATH` 只有 `/usr/bin:/bin`，`/usr/local/bin` 不在里面。
2. **工作目录不同**：cron 在用户家目录执行，脚本里用相对路径就找不到文件。
3. **没有加载 profile**：`~/.bashrc` 里的 alias、变量在 cron 里都不存在。
4. **没有终端**：依赖交互（`read`、`sudo` 输密码）的命令直接失败。

标准做法：**脚本内写绝对路径 + 显式设置环境**。

```bash
#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd /opt/app || exit 1
```

crontab 里也统一重定向，避免输出塞满邮箱：

```text
10 3 * * * /opt/app/backup.sh >>/var/log/backup.log 2>&1
```

### 防并发：任务重叠是隐形杀手

备份跑了 40 分钟，cron 每 30 分钟又起一个，最后几个进程抢同一份文件。用 `flock` 解决：

```bash
* * * * * flock -n /var/lock/backup.lock /opt/app/backup.sh
```

或者脚本内部：

```bash
exec 9>/var/lock/backup.lock
flock -n 9 || { echo "已有实例在跑，退出"; exit 0; }
```

`-n` 表示不等待、直接退出。宁可少跑一次，也不要跑两份。

### 防误删的四道锁

1. **变量必带默认值并校验**：`[ -n "${DIR:-}" ] || exit 1`。
2. **删前打日志并确认路径存在**：`[ -d "$DIR" ] || exit 1`。
3. **用 `-maxdepth` 限制范围**：`find /var/log -maxdepth 1 -name '*.gz' -mtime +30 -delete`。
4. **危险操作先 dry-run**：

```bash
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "would delete: $p"
else
  rm -f "$p"
fi
```

再加一道保险：`rm` 别名或 `trash` 工具，别让 `rm -rf` 直接面对线上路径。

### 真实事故复盘（简化）

```bash
# 出事版本
find /backup -name "*.tar.gz" -mtime +7 -delete
```

原因：`/backup` 当时挂载失败，变成空目录 `/backup`，但脚本照跑；且没有锁，多个实例同时执行。修复：

```bash
mountpoint -q /backup || { echo "挂载丢失，退出"; exit 1; }
find /backup/daily -maxdepth 1 -name '*.tar.gz' -mtime +7 -delete
```

**加一行挂载检查，就能避免整机备份被清空**。

### 替代方案：systemd timer

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Daily backup

[Timer]
OnCalendar=*-*-* 03:10:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now backup.timer
systemctl list-timers
journalctl -u backup.service -n 30
```

比 cron 好在：有日志（进 journald）、有依赖管理、错过任务可补跑（`Persistent=true`）、能看下次执行时间。

### 本章要点

- cron 五个字段，编辑用 `crontab -e`。
- "手动能跑、cron 不行"基本都是 PATH 和工作目录。
- 用 `flock` 防重叠，用挂载与存在性检查防误删。
- 重要任务优先用 systemd timer，日志和补跑都更省心。
