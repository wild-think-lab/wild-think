---
title: systemd 与日志速查
summary: unit 写在哪、怎么写一个能自启的服务、依赖与重启策略、journalctl 的高频过滤、coredump 与资源限制，一页放全。
group: Linux
order: 2
tags: [systemd, journalctl, 服务, 运维]
---

## unit 放哪里

| 路径 | 用途 |
| --- | --- |
| `/lib/systemd/system/` | 软件包自带的，别手改（升级会被覆盖） |
| `/etc/systemd/system/` | 本机覆盖与自建服务，优先级最高 |
| `/etc/systemd/system/<svc>.d/*.conf` | 用 drop-in 只改几个字段 |
| `/usr/lib/systemd/user/` | 用户级服务 |

改完必须 `systemctl daemon-reload`，否则不生效。改 drop-in 也一样。

## 一个能上线的 service

```ini
[Unit]
Description=Order API
After=network-online.target mysql.service
Wants=network-online.target
# 启动次数限制用 StartLimit*，别让它无限重启把 CPU 烧掉
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/opt/order
EnvironmentFile=/etc/order/env
ExecStartPre=/usr/bin/test -r /etc/order/env
ExecStart=/opt/order/bin/order-api
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5s
TimeoutStopSec=20s
KillSignal=SIGTERM
# 资源限制
LimitNOFILE=65535
MemoryMax=2G
CPUQuota=200%

[Install]
WantedBy=multi-user.target
```

要点：

- `Type=simple` 最常见；`forking` 只用于自己 daemon 化的老程序。
- `Restart=on-failure` 而不是 `always`：正常退出不该被拉起。
- `TimeoutStopSec` 要和应用优雅退出时间对齐，不然会被 SIGKILL。
- `EnvironmentFile` 里不要加引号和注释符号的错误写法（`KEY=value`，值里有空格也不需要引号）。

## 常用操作

```bash
systemctl daemon-reload
systemctl enable --now order-api
systemctl status order-api -l --no-pager
systemctl restart order-api
systemctl reload order-api          # 只有配了 ExecReload 才有意义
systemctl list-units --failed
systemctl list-unit-files | grep enabled
systemctl cat order-api             # 看最终生效的所有配置段（含 drop-in）
systemctl show order-api -p Restart -p ExecStart
```

排障先看 `systemctl cat`——很多"配置不生效"是因为另一个目录里还有一份覆盖。

## journalctl 高频过滤

```bash
journalctl -u order-api -n 100 --no-pager
journalctl -u order-api --since '2026-11-27 09:00' --until '2026-11-27 10:00'
journalctl -p err -b                       # 本次启动以来的 error 及以上
journalctl -f -u nginx                     # 跟踪
journalctl _PID=12345                      # 按 pid
journalctl -k -b -1                        # 上一次启动的内核日志
journalctl --disk-usage
journalctl --vacuum-time=14d               # 只留 14 天
journalctl --vacuum-size=500M
```

`-b -1` 是查"上次为什么重启"的常用入口：OOM、硬件错误、panic 都在这。

## 定时任务：timer 而不是 cron

```ini
# order-cleanup.timer
[Unit]
Description=Daily cleanup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true          # 错过就补跑（关机期间）
RandomizedDelaySec=300   # 打散，避免同一时刻全机跑

[Install]
WantedBy=timers.target
```

```bash
systemctl list-timers --all
systemctl status order-cleanup.timer
journalctl -u order-cleanup.service
```

`OnCalendar` 语法：`Mon-Fri 09:00`、`*-*-* 00/2:00:00`（每 2 小时）。`Persistent=true` 是 cron 没有的关键能力。

## 资源限制与 cgroup 观察

```bash
systemd-cgtop                       # 按 cgroup 看 CPU/内存/IO
systemctl show order-api -p MemoryCurrent -p CPUUsageNSec
cat /sys/fs/cgroup/system.slice/order-api.service/memory.current
```

`MemoryMax` 超过后会被 cgroup OOM killer 干掉，日志里是 `oom-kill` 而不是应用自己报错。这种"进程突然消失"要往 cgroup 查。

## 崩溃转储

```bash
coredumpctl list
coredumpctl info <PID>
coredumpctl gdb <PID>       # 直接进 gdb 看栈
```

需要在 `/etc/systemd/coredump.conf` 里确认 `Storage` 不是 `none`，并配好 `kernel.core_pattern`。
