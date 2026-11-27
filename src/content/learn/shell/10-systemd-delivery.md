---
title: 让脚本被系统接管：systemd 与交付
module: 进阶篇
summary: 用 systemd 管理脚本、日志进 journal、权限与资源限制、交付清单与五个"部署后跑不起来"的原因。
minutes: 40
---

### 为什么用 systemd 而不是 nohup

```
nohup：能后台，但没有重启、没有状态、日志散落
systemd：开机自启、崩溃重启、日志统一、资源限制
```

### 一个完整的 unit

```ini
# /etc/systemd/system/app-sync.service
[Unit]
Description=App data sync
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/opt/app
EnvironmentFile=/etc/app-sync/env
ExecStart=/opt/app/bin/sync.sh
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30

# 资源与安全
Nice=5
MemoryMax=512M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/data/app

[Install]
WantedBy=multi-user.target
```

**要点**：

```
① Restart=on-failure + RestartSec（防抖动）
② EnvironmentFile 放配置（不写死在脚本里）
③ ProtectSystem/ReadWritePaths（最小写权限）
④ MemoryMax（防"一个脚本吃光内存"）
```

### 一次性任务（oneshot）

```ini
[Service]
Type=oneshot
ExecStart=/opt/app/bin/job.sh
RemainAfterExit=no
```

配 timer 用（见定时任务章节）。

### 日志

```bash
journalctl -u app-sync -f
journalctl -u app-sync --since "10 min ago" -p err
```

**"脚本自己写 /var/log/app.log"** 也可以，但交给 journald 更省事（有轮转、可按服务查）。

### 交付清单

```
① unit 文件（含依赖与重启策略）
② 配置样例 + 环境变量说明
③ 安装脚本（复制 unit → daemon-reload → enable）
④ 卸载脚本（stop → disable → 删文件）
⑤ README：端口、目录、权限、日志位置
```

### 安装脚本

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

install -d -o app -g app /opt/app /data/app
install -m 0755 bin/sync.sh /opt/app/bin/sync.sh
install -m 0644 deploy/app-sync.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now app-sync
systemctl --no-pager status app-sync | head -5
```

**"让对方手动 cp + 手动 systemctl"** 会在第三步漏掉 `daemon-reload`。

### 五个"部署后跑不起来"

**① 路径/用户不对**

```
unit 里 User=app，但目录属主是 root → 读不到
```

**② 环境变量缺失**

```
EnvironmentFile 路径写错 → 变量为空
```

**③ 没 daemon-reload**

```
改了 unit 但 systemd 还用旧版本
```

**④ SELinux 阻止**

```
自定义路径没有正确上下文 → Permission denied（但 root 手动能跑）
→ 用 semanage fcontext 或 audit2allow 分析
```

**⑤ 资源限制**

```
MemoryMax 太小 → 被 OOM 杀（journal 里能看到）
```

### 检查清单

```
□ 有 unit（不是 nohup）
□ Restart + RestartSec
□ EnvironmentFile 管理配置
□ 最小权限（User/ProtectSystem/ReadWritePaths）
□ 有资源上限
□ 日志进 journal 或规范文件
□ 有安装/卸载脚本
□ README 写清端口/目录/权限
□ 验证：重启后自启
□ 验证：kill 进程后自动重启
```
