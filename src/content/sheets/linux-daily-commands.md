---
title: Linux 日常命令速查
summary: 找文件、看磁盘、查进程、管道处理、批量改文本——运维现场最常敲的三十条，带参数解释和不常用但关键时刻救命的写法。
group: Linux
order: 1
tags: [Linux, 命令, 运维]
---

## 文件与目录

```bash
ls -lh --time-style=long-iso          # 人类可读大小 + 标准时间
ls -lt | head -20                      # 最近改过的 20 个
du -sh * | sort -rh | head -10         # 当前目录下谁最占空间
du -shx /* 2>/dev/null | sort -rh      # 全盘一级目录排序（x 不跨文件系统）
df -hT                                 # 按文件系统看容量与类型
df -i                                  # inode 是否用尽（满了也会报"磁盘满"）
find /var/log -type f -size +200M -mtime +7 -ls
find . -name '*.log' -mmin -30         # 30 分钟内改过的
find . -type f -newermt '2026-11-20'   # 某日期之后的
```

`stat 文件` 看三个时间：`Access` 访问、`Modify` 内容改、`Change` 元数据（权限/属主）改。`find -mtime` 用的是 Modify。

## 磁盘与空间

```bash
ncdu /data                 # 交互式，比 du 好用得多
lsof +L1                   # 找出"文件已删但空间没释放"的进程（经典磁盘满元凶）
journalctl --disk-usage    # 系统日志占多少
du -sh /var/lib/docker/*   # 容器环境先看这里
```

**空间没释放的标准处理**：`lsof +L1` 找到 PID，重启或 `kill -HUP` 那个进程；临时救急可以 `: > /proc/<pid>/fd/<n>` 截断。

## 进程与资源

```bash
ps aux --sort=-%mem | head -10
ps -eo pid,ppid,%cpu,%mem,rss,etime,cmd --sort=-%cpu | head
pgrep -af nginx           # 按名字找，带完整命令行
pidstat -p 1234 1 5       # 单进程 CPU/IO 每 5 秒
top -H -p 1234            # 看该进程内的线程
```

`RSS` 是常驻内存，`VSZ` 是虚拟地址空间（不用太在意）。判断内存泄漏看 RSS 是否单调上涨。

## 管道与文本

```bash
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -20
awk -F'"' '{print $2}' access.log | awk '{print $1, $2}' | sort | uniq -c | sort -rn
grep -c ' 500 ' access.log
grep -v 'healthz' access.log | tail -100
sed -n '100,140p' file.txt          # 只打印指定行
sed -i.bak 's/old/new/g' file       # 带备份替换
sort -t$'\t' -k2 -nr file           # 按第二列数字倒序
cut -d: -f1 /etc/passwd
tr -s ' ' '\n' < file | sort -u
paste -d'|' a.txt b.txt
```

长文本处理三件套分工：`grep` 筛行 → `awk` 取列/计算 → `sort|uniq -c` 统计。够用，不必上 Python。

## 批量与并行

```bash
for f in *.log; do gzip -9 "$f"; done
find . -name '*.tmp' -delete
xargs -I{} -P8 sh -c 'sha256sum "{}"' < list.txt    # 8 并发
```

`-P` 并发数不要超过核数×2；`xargs -0` 配 `find -print0` 才能处理带空格的文件名。

## 时间与时区

```bash
date -u                        # UTC
timedatectl                    # 时区、NTP 同步状态
timedatectl set-timezone Asia/Shanghai
ntpq -p                        # 老工具
chronyc sources -v             # chrony 环境
```

服务器时区错误会导致日志时间全乱、证书校验失败、定时任务跑偏。

## 一条命令看全系统

```bash
uptime; free -h; df -hT | grep -v tmpfs; ss -lntp | head -20
```

比"打开三个监控面板"快，登机器第一件事敲它。
