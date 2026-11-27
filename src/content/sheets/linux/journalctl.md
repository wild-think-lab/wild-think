---
title: journalctl 速查
summary: 按服务/时间/优先级/启动次数查询日志、输出格式、清理与持久化配置。
group: linux
order: 1
tags: [Linux, systemd, 日志]
---

### 基础

```bash
journalctl -u nginx                    # 某服务
journalctl -u nginx -f                 # 跟随
journalctl -u nginx --since "1 hour ago"
journalctl -u nginx --since today
journalctl -u nginx --until "2026-11-27 10:00"
journalctl -n 100                      # 最近 100 行
journalctl -p err -b                   # 本次启动的 error 及以上
```

### 优先级

```
0 emerg  1 alert  2 crit  3 err  4 warning  5 notice  6 info  7 debug
```

```bash
journalctl -p 3..4 --no-pager          # err 到 warning
```

### 启动与内核

```bash
journalctl --list-boots               # 启动列表
journalctl -b 0                       # 本次
journalctl -b -1                      # 上次
journalctl -k -p err                  # 内核错误
```

### 按进程/字段

```bash
journalctl _PID=1234
journalctl _COMM=sshd
journalctl -u nginx -o json-pretty | head -20
```

### 输出格式

```bash
journalctl -o short-iso               # 带时区 ISO 时间
journalctl -o json                    # 结构化（可喂 jq）
journalctl -o cat                     # 只要消息
```

### 持久化（默认可能只在内存）

```bash
mkdir -p /var/log/journal
systemctl restart systemd-journald
# 或用 /etc/systemd/journald.conf
Storage=persistent
SystemMaxUse=2G
```

### 清理与空间

```bash
journalctl --disk-usage
journalctl --vacuum-size=1G
journalctl --vacuum-time=7d
```

### 导出给他人排查

```bash
journalctl -u app --since "2026-11-27 09:00" --no-pager > /tmp/app.log
journalctl -b -1 -p err --no-pager > /tmp/last-boot-err.log
```

### 判据表

| 需求 | 命令 |
| --- | --- |
| 服务为什么重启 | `journalctl -u x --since "10 min ago"` |
| 开机报错 | `journalctl -b -1 -p err` |
| 内核 OOM | `journalctl -k \| grep -i "oom"` |
| 时间范围精确 | `--since "2026-11-27 10:00:00"` |
| 结构化分析 | `-o json` + jq |
| 磁盘占用 | `--disk-usage` |

### 坑

```
① 没持久化 → 重启后日志没了
② 容器日志不在 journalctl（用 docker logs / crictl logs）
③ 时区：加 -o short-iso 明确时区
④ 大量 debug 日志 → 先看 -p err 再看全量
⑤ --vacuum 会删历史，排障时别急着清
```
