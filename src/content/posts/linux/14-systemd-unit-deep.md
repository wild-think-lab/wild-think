---
title: systemd unit 写对了能省很多事
description: 从"能起来"到"生产级"：依赖顺序、重启策略、资源限制、日志、安全加固、以及五个常见写错的配置。
date: 2024-02-21
tags: [Linux, systemd, 运维]
---

### 最小可用 vs 生产可用

```ini
# 能起来
[Unit]
Description=my app
After=network.target

[Service]
ExecStart=/opt/app/bin/app
Restart=always

[Install]
WantedBy=multi-user.target
```

**缺什么**：

```
① 没有依赖声明（DB 没起来就启动 → 报错退出）
② 没有资源限制（OOM 时被内核杀）
③ 没有日志配置（看不到输出）
④ 没有安全加固（以 root 跑、能写任意文件）
⑤ 没有重载/停止的优雅处理
```

### 生产版本

```ini
[Unit]
Description=Order Service
Documentation=https://wiki.example.com/order
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service
PartOf=order-stack.target

[Service]
Type=notify
User=order
Group=order
WorkingDirectory=/opt/order
EnvironmentFile=/etc/order/env
ExecStartPre=/usr/bin/test -f /etc/order/config.yaml
ExecStart=/opt/order/bin/order-server
ExecReload=/bin/kill -HUP $MAINPID
ExecStop=/bin/kill -TERM $MAINPID
TimeoutStopSec=30
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=3

# 资源限制
LimitNOFILE=65535
MemoryMax=2G
CPUQuota=200%

# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=order

# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/order /var/log/order
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
```

### 逐段解释

**`Type` 的四种**

```
simple   默认，ExecStart 一启动就认为服务就绪（适合前台进程）
notify   服务自己调 sd_notify 通知就绪（最准确，需应用支持）
forking  传统 daemon（父进程退出后认为就绪）
oneshot  只跑一次就退出（适合初始化脚本）
```

**用 `simple` 的坑**：服务还在初始化（连 DB）时就认为"已就绪"，此时健康检查会失败。

**推荐 `notify`**（如果应用支持）：就绪时间准确。

**依赖的四个关键字**

```
After          排序（在谁之后启动）
Requires       强依赖（依赖失败则本服务也失败）
Wants          弱依赖（依赖失败本服务继续）
PartOf        停止/重启时联动
```

**经典错误：只写 `After=postgresql.service`**

```
只排序，不保证 PG 真的就绪
→ 应用启动时 PG 还在恢复 → 连接失败

正确：
Requires=postgresql.service
After=postgresql.service
# 或者干脆在应用里加重试
```

**`network.target` vs `network-online.target`**

```
network.target         网络栈初始化完成（但不保证有 IP/DNS）
network-online.target  网络真正可用（有地址、路由）
```

**服务需要出网/解析 DNS → 用 `network-online.target`**。

**重启策略**

```
Restart=no           不重启（默认）
Restart=always       总是重启（含正常退出）
Restart=on-failure   非 0 退出时重启（推荐）
Restart=on-abnormal  被信号杀/超时时重启
```

**必须配 `StartLimitIntervalSec` + `StartLimitBurst`**：

```
如果服务一启动就崩，不做限制 → 无限重启 → 疯狂写日志
```

**三个资源限制**

```
LimitNOFILE   文件描述符（默认 1024，服务类要调到 65535）
MemoryMax     内存上限（超了 OOM kill 该服务，不影响整机）
CPUQuota      百分比（200% = 2 核）
```

**`MemoryMax` 的价值**：**让内核杀"这个服务"而不是杀整机上的随机进程**。

**安全加固的七件套**

| 选项 | 作用 |
| --- | --- |
| NoNewPrivileges | 禁止提权（setuid 无效） |
| PrivateTmp | 独立 /tmp（防临时文件冲突） |
| ProtectSystem=strict | 整个文件系统只读 |
| ProtectHome | 看不到 /home /root |
| ReadWritePaths | 显式放开可写目录 |
| ProtectKernelTunables/Modules | 不能改内核参数/加载模块 |
| RestrictAddressFamilies | 只允许特定 socket 类型 |

**`ProtectSystem=strict` 是最关键的**：即使应用被攻破，也写不了 `/etc`、`/usr`。

### 五个常见写错

**① ExecStart 用了相对路径**

```
❌ ExecStart=./app
✅ ExecStart=/opt/app/bin/app
```

systemd 不继承你的 shell 环境，相对路径找不到。

**② 环境变量没生效**

```
❌ [Service]
   FOO=bar

✅ Environment="FOO=bar"
   或 EnvironmentFile=/etc/app/env
```

**③ 用了 shell 语法**

```
❌ ExecStart=/bin/bash -c "cd /opt/app && ./app"
✅ WorkingDirectory=/opt/app
   ExecStart=/opt/app/app
```

`-c` 里的 `&&` 依赖 bash，且 systemd 无法正确跟踪进程（停止时杀不掉真正的进程）。

**④ 前台/后台搞错**

```
如果应用自己 daemon 化（fork 到后台）：
  Type=forking + PIDFile=/var/run/app.pid
否则 systemd 认为"进程退出了"，会反复重启
```

**⑤ 停止信号不对**

```
有些应用只认 SIGINT，不认 SIGTERM
→ ExecStop=/bin/kill -INT $MAINPID
```

### 常用操作

```bash
systemctl daemon-reload        # 改 unit 文件后必须执行
systemctl enable --now app
systemctl status app
systemctl restart app
journalctl -u app -f           # 跟踪日志
journalctl -u app --since "10 min ago"
systemd-analyze verify /etc/systemd/system/app.service    # 校验 unit
systemctl show app             # 看所有生效的属性
```

**`systemd-analyze verify` 能提前发现语法与路径错误**。

### 定时任务用 timer，不用 cron

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Daily backup

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/backup.service
[Unit]
Description=Backup job

[Service]
Type=oneshot
ExecStart=/opt/scripts/backup.sh
```

**比 cron 强的地方**：

```
① 有日志（journalctl -u backup）
② Persistent=true（关机错过会补跑）
③ RandomizedDelaySec（避免所有机器同一秒跑）
④ 有依赖（可在网络就绪后跑）
```

### 检查清单

```
□ Type 明确（能用 notify 就用）
□ 依赖写 Requires + After（不只是 After）
□ 需要出网用 network-online.target
□ Restart=on-failure + StartLimitBurst
□ LimitNOFILE=65535
□ MemoryMax（防拖垮整机）
□ 用非 root 用户
□ NoNewPrivileges + ProtectSystem=strict + ReadWritePaths
□ ExecStart 用绝对路径
□ 改 unit 后 daemon-reload
□ systemd-analyze verify 校验过
□ 定时任务用 timer（不用 cron）
```
