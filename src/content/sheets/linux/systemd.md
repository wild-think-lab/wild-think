---
title: systemd 速查
summary: unit 结构、常用命令、timer 写法、日志与排错，以及"改了不生效"的常见原因。
group: linux
order: 1
tags: [Linux, systemd]
---

### unit 三段

```ini
[Unit]
Description=My App
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/app --port 8080
Restart=always
RestartSec=5
User=app
Environment=ENV=prod
WorkingDirectory=/opt/app

[Install]
WantedBy=multi-user.target
```

### 常用命令

```bash
systemctl daemon-reload
systemctl enable --now app
systemctl status app
systemctl restart app
systemctl stop app
systemctl disable app
systemctl list-units --type=service --state=running
systemctl list-unit-files --state=enabled
systemctl cat app                    # 看最终合并后的 unit
systemctl show app -p Restart -p ExecStart
journalctl -u app -n 100 --no-pager
journalctl -u app -f
journalctl -u app --since "10 min ago"
```

### Type 的取舍

```
simple     ：ExecStart 后立即认为启动完成（最常用）
notify     ：进程调用 sd_notify 才算启动完成（最准确）
forking    ：老式守护进程（pid 文件）
oneshot    ：跑一次就结束（配合定时/初始化）
```

**"服务起来了但 systemctl start 卡住"** → 用 `Type=simple` 而不是 `forking`。

### Timer（替代 cron）

`/etc/systemd/system/backup.timer`：

```ini
[Unit]
Description=Daily backup

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

`/etc/systemd/system/backup.service`：

```ini
[Service]
Type=oneshot
ExecStart=/usr/local/bin/backup.sh
```

```bash
systemctl enable --now backup.timer
systemctl list-timers --all
```

**`Persistent=true`** 表示"错过的执行会补跑"（cron 做不到）。

### 五个"改了不生效"

```
① 忘了 systemctl daemon-reload
② 改了 /lib/systemd/system/（被 /etc 覆盖）
   → 用 systemctl edit 生成 override
③ unit 名与文件名不一致（app.service vs app@.service）
④ Environment 里的变量在 ExecStart 未展开（要用 sh -c）
⑤ 依赖顺序错（network-online.target 未 Wants）
```

### override（推荐做法）

```bash
systemctl edit app
# 生成 /etc/systemd/system/app.service.d/override.conf
```

```ini
[Service]
RestartSec=15
```

**"不直接改原 unit"** —— 升级包时会覆盖。

### 排错三板斧

```bash
systemctl status app -l --no-pager
journalctl -u app -n 200 --no-pager
systemd-analyze verify /etc/systemd/system/app.service
```

**"status 里 Active: failed (Result: exit-code)"** → 看 journalctl 的退出码。

### 常用加固项

```ini
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/app
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

**"加了 ProtectSystem=strict 后写不了文件"** → 用 ReadWritePaths 放行。
