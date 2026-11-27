---
title: 系统层排错：CPU、内存、磁盘、进程
module: 入门篇
summary: 用六条命令建立"系统体检"，然后按 CPU、内存、磁盘、进程四类给出判读阈值与处理动作。
minutes: 24
---

### 六条命令的体检

```bash
uptime              # 负载与运行时长
free -h             # 内存与 swap
df -h               # 磁盘容量
df -i               # inode
ss -lntp            # 监听端口与进程
dmesg -T | tail -30 # 内核消息（OOM、磁盘、网卡）
```

**这六条能覆盖 70% 的"服务器不正常"**。

### CPU：负载高先分清"算"还是"等"

```bash
uptime
# load average: 8.20, 6.10, 5.30

vmstat 1 5
# procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu------
#  r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
#  8  2      0 120000  8000 900000    0    0    120    80  800 1200 75  8 12  5  0
```

**判读**：

```
r（运行队列） > CPU 核数 → CPU 真的不够（us 会很高）
b（阻塞）    > 0 且 wa 高 → 在等 IO（不是 CPU 不够）
si/so        持续 > 0    → 在用 swap（内存不足，性能崩塌）
```

**关键结论：负载高不等于 CPU 忙**。

```
load 高 + us 低 + wa 高 → 查磁盘
load 高 + us 高          → 查进程
load 高 + si/so 高       → 查内存
```

**找占用 CPU 的进程**：

```bash
top -H -o %CPU        # 按线程看
pidstat -u 1 5        # 每进程 CPU
ps -eo pid,ppid,pcpu,pmem,cmd --sort=-pcpu | head
```

**找哪段代码在烧 CPU**：

```bash
# 用 perf
perf top -p <pid>
# 或
perf record -F 99 -p <pid> -g -- sleep 30
perf report
```

### 内存：先看 OOM，再看泄漏

```bash
free -h
#               total        used        free      shared  buff/cache   available
# Mem:           15Gi        9.2Gi       1.0Gi       200Mi        5.5Gi        5.4Gi
```

**`available` 才是"还能用多少"**（buff/cache 可回收）。

**关键判断**：

```
available 很低 + swap used 高 → 真的内存不足
available 充足 + 应用报 OOM → 应用自己的 limit（如 JVM heap、容器 limit）
```

**查 OOM**：

```bash
dmesg -T | grep -i "out of memory"
journalctl -k | grep -i oom
# 会看到 "Killed process 1234 (java)"
```

**容器里的 OOM** 不在 dmesg，而是：

```bash
kubectl describe pod <pod> | grep -A3 "Last State"
# Reason: OOMKilled
```

**查内存泄漏（持续增长）**：

```bash
# 观察 30 分钟的变化
for i in $(seq 1 6); do
  ps -o rss= -p <pid>; sleep 300
done
```

或：

```bash
pidstat -r 60 10      # 每 60 秒采一次 RSS
```

**`RSS` 持续上涨不回落的，就是泄漏**（正常应用会有 GC/释放）。

### 磁盘：df 与 du 的差异是关键

```bash
df -h
df -i
du -sh /var/* 2>/dev/null | sort -h
```

**必查的三种"假满"**：

```
① inode 满（df -i 100%）→ 小文件太多
② 已删除但被占用（df 与 du 差异大）→ lsof +L1
③ 挂载点被覆盖（findmnt 看是否真挂上）
```

**查 IO 压力**：

```bash
iostat -xz 1 5
# await 高 + %util 接近 100% → 磁盘饱和
```

**找写盘最多的进程**：

```bash
iotop -oPa
# 或
pidstat -d 1 5
```

**临时救急**：

```bash
# 清日志（注意别删正在写的）
journalctl --vacuum-size=200M
find /var/log -name "*.log.*" -mtime +7 -delete
```

### 进程：进程还在但服务不正常

```bash
systemctl status app
ss -lntp | grep app
cat /proc/<pid>/status | head -20
```

**四个"进程在但服务坏"的情况**：

```
① 线程卡死（进程在，但不处理请求）→ jstack/pstack/gdb
② 死锁 → 看线程栈
③ 端口被占用（新进程起不来）→ ss -lntp
④ 僵尸/僵死（父进程没收尸）→ ps 看 Z 状态
```

**查线程卡在哪**：

```bash
# Java
jstack <pid> | less
# Go
kill -QUIT <pid>        # 会打印全部 goroutine 栈
# 通用
cat /proc/<pid>/task/*/stack    # 内核栈（需 root）
```

**查端口被谁占**：

```bash
ss -lntp | grep :8080
lsof -i :8080
```

### 一个完整的判断路径

```
现象：服务不可用
  ↓
systemctl status app            → 进程在吗？
  ↓ 在
ss -lntp | grep <port>          → 端口在听吗？
  ↓ 在
curl localhost:<port>           → 本机能通吗？
  ↓ 通
curl <ip>:<port>                → 外部能通吗？
  ↓ 不通 → 防火墙/安全组
  ↓ 通
看应用日志与依赖日志              → 应用/依赖
```

### 常见误判

```
❌ "load 15 说明 CPU 不够" → 也可能是 IO 等待
❌ "free 只剩 1G 要挂了" → 看 available，buff/cache 可回收
❌ "df 还有空间就能写" → 还要看 inode 与被删文件
❌ "进程在就是好的" → 线程可能卡死
❌ "重启能好就是修好了" → 没有根因，还会再犯
```

### 检查清单

```
□ 六条体检命令（uptime/free/df/df -i/ss/dmesg）
□ load 高先分 us 还是 wa
□ 内存看 available 与 OOM 记录
□ 容器 OOM 看 describe pod 的 Last State
□ 泄漏看 RSS 是否持续上涨
□ 磁盘查 inode、被删占用、挂载点
□ IO 看 iostat 的 await 与 %util
□ 进程在但坏 → 看线程栈
□ 端口占用用 ss -lntp 定位
□ 修复能说出根因
```
