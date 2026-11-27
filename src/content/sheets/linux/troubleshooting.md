---
title: 排障命令速查：从"哪里慢"到"为什么慢"
summary: 一页装下 CPU、内存、IO、网络、进程五类问题的第一命令，每条都说明"看哪个数字下结论"。
group: Linux
order: 3
tags: [linux, 排障, 性能]
---

### 先看全局

```bash
uptime                  # load average（1/5/15）
top                     # 按 1 看每核，按 M 按内存排
vmstat 1 5              # r/b/si/so/us/sy/wa/id
```

判断：

| 数字 | 含义 |
| --- | --- |
| `r` > 核数 | CPU 排队 |
| `b` > 0 且 `wa` 高 | IO 阻塞 |
| `si/so` > 0 | 在用 swap（性能灾难） |
| `sy` 高 | 系统调用/内核开销大 |

### CPU

```bash
pidstat -u 1 5              # 每进程 CPU
top -H -p <pid>             # 每线程
perf top -p <pid>           # 热点函数
perf record -F 99 -p <pid> -g -- sleep 10 && perf report
```

判据：`us` 高是计算密集；`sy` 高是系统调用多（看 strace/eBPF）；`wa` 高不是 CPU 问题。

### 内存

```bash
free -m                     # 看 available
ps aux --sort=-%mem | head
smem -r 2>/dev/null | head  # 按实际占用（共享内存去重）
dmesg -T | grep -i 'killed process'   # OOM 记录
```

判据：`available` 才是"能用"的量；`free` 小是正常的页缓存。

```bash
cat /proc/<pid>/status | grep -E 'VmRSS|VmSwap'
```

### IO

```bash
iostat -x 1 5               # %util、await、r/s w/s
iotop -oP                   # 哪个进程在写
pidstat -d 1 5
lsof +L1                    # 已删除但仍占用的文件
```

判据：`await` 高（> 20ms 对 SSD 就不正常）+ `%util` 接近 100 → 磁盘饱和。

### 网络

```bash
ss -s                                  # 总览
ss -lntp                               # 监听端口
ss -ant state established | wc -l      # 已建立连接数
ss -ant state time-wait | wc -l        # TIME_WAIT
sar -n DEV 1 5                         # 每网卡流量
iftop -n                               # 谁在占带宽
```

判据：TIME_WAIT 多 = 短连接多；SYN_RECV 多 = backlog 不足或 SYN flood。

### 进程与文件

```bash
ps -ef | grep <name>
lsof -p <pid>                # 该进程打开的所有文件
ls -l /proc/<pid>/fd | head  # fd 数量与类型
cat /proc/<pid>/limits       # 该进程的限制
strace -f -p <pid> -c        # 系统调用统计（有开销，短时用）
```

### 磁盘空间

```bash
df -h; df -i                 # 空间 / inode
du -sh /* 2>/dev/null | sort -h | tail -5
find / -xdev -size +500M -type f 2>/dev/null | head
```

"删了文件但不释放"：

```bash
lsof +L1 | sort -k7 -n | tail
# 解决：重启该进程，或 : > /proc/<pid>/fd/<n>
```

### 内核与参数

```bash
sysctl -a | grep <key>
ulimit -a
cat /proc/sys/net/core/somaxconn
dmesg -T | tail -30          # 硬件/驱动/内核错误
```

### 五分钟排障顺序

```
① uptime + top        看是不是"真的慢"
② vmstat              区分 CPU / IO / 内存
③ pidstat -u -d       定位到进程
④ 该维度的深入工具     perf / iostat / ss
⑤ 证据：截图 + 日志切片，别急着重启
```
