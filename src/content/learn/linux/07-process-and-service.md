---
title: 进程与服务：让程序在后台活下去
module: 入门篇
summary: 进程怎么看、怎么杀，systemd 怎么管服务，以及"程序一关终端就死"的根本原因。
minutes: 20
---

### 先分清"进程"和"服务"

- **进程**：正在运行的程序实例，有一个 PID。
- **服务（service）**：被 systemd 管起来的长期进程，能开机自启、能自动重启、有统一的状态查询。

你自己在终端敲 `python app.py`，那是进程不是服务——**关掉终端它就死**。要让它长期活着，得交给 systemd。

### 看进程

```bash
ps aux                 # 所有进程，看 CPU/内存占比
ps aux | grep nginx    # 找特定进程
top                    # 实时排行，q 退出；按 M 按内存排、P 按 CPU 排
pgrep -a nginx         # 直接拿 PID 和命令
```

`ps` 输出的关键列：`PID`（进程号）、`%CPU`、`%MEM`、`STAT`（`S` 睡眠、`R` 运行、`Z` 僵尸）、`COMMAND`。

### 端口被谁占着

服务起不来，最常见的原因是端口被占了：

```bash
ss -lntp               # 所有监听端口 + 对应进程
ss -lntp | grep 80
lsof -i :80            # 另一种查法
```

看到 `Address already in use`，就用这两条找出占坑的进程，再决定是改端口还是杀掉它。

### 杀进程：先温和，后强硬

```bash
kill PID               # 发 SIGTERM，程序有机会保存数据再退出
kill -9 PID            # SIGKILL，直接杀，不保证数据完整
pkill -f "python app"  # 按命令行匹配
```

先用 `kill`，等几秒没反应再 `-9`。上来就 `-9`，数据库有可能留下损坏的文件。

### systemd：现代 Linux 管服务的唯一入口

```bash
systemctl start nginx        # 启动
systemctl stop nginx
systemctl restart nginx      # 重启（改完配置必做）
systemctl reload nginx       # 平滑重载配置，不断连接（nginx 支持）
systemctl status nginx       # 状态 + 最近几行日志
systemctl enable nginx       # 开机自启
systemctl is-enabled nginx
systemctl list-units --type=service --state=running
```

`start` 和 `enable` 完全不同：`start` 是现在跑起来，`enable` 是开机时跑起来。**只 start 不 enable，重启服务器后服务就没了**——这是新手最常见的线上事故。

### 写一个自己的服务单元

把程序交给 systemd，编辑 `/etc/systemd/system/myapp.service`：

```ini
[Unit]
Description=My App
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/myapp
ExecStart=/usr/bin/python3 /opt/myapp/app.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

关键是 `Restart=always`：进程崩了 3 秒后自动拉起，这才是"服务"和"进程"的差别。

改完必须让 systemd 重新读配置，否则它不认识你的新单元：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now myapp
journalctl -u myapp -n 50 --no-pager   # 看它自己的日志
```

少了 `daemon-reload` 这一步，改完的 service 文件等于没改——这是最典型的"我明明改了却没生效"。

### 自己验证

```bash
systemctl status nginx
ss -lntp | grep :80
sudo systemctl restart nginx
journalctl -u nginx -n 20 --no-pager
sudo systemctl is-enabled nginx
```

### 本章小结

- 进程有关键的 PID；`ps aux`、`top`、`ss -lntp` 是三个观察窗口。
- 先 `kill` 后 `kill -9`，别一上来就强杀。
- `start` ≠ `enable`，改单元文件必须 `daemon-reload`。
- `Restart=always` 让程序从"进程"升级成"服务"。

**下一章**：出问题了，先看哪个日志。
