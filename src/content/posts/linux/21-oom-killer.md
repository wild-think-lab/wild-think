---
title: OOM Killer：谁杀了我的进程
description: 为什么会被杀、怎么找出"谁吃了内存"、cgroup 与内核两套机制，以及五个"内存看着够却 OOM"的原因。
date: 2026-11-27
tags: [Linux, 内存, 排障]
---

### 先确认"是谁杀的"

```bash
dmesg -T | grep -iE "out of memory|killed process"
journalctl -k | grep -i "oom"
```

**典型输出**：

```
Out of memory: Killed process 12345 (java) total-vm:8GB, anon-rss:7.9GB
```

**"Killed process"** 后面的 PID/进程名就是答案。

### 内核 OOM 与 cgroup OOM 的区别

```
内核 OOM Killer：整机内存不足 → 按 oom_score 杀进程
cgroup OOM     ：某个 cgroup 超限 → 只杀该组内进程
```

**容器里"进程莫名被杀"** → 大概率是 cgroup 限制（`memory.max`）。

```bash
cat /sys/fs/cgroup/memory.max         # cgroup v2
cat /sys/fs/cgroup/memory.events
# 看 oom 与 oom_kill 计数
```

### 怎么找"谁吃了内存"

```bash
free -m
ps aux --sort=-rss | head -10
smem -rks                              # 更准确（含共享内存）
cat /proc/meminfo | head -20
```

**"free 显示可用很多但 OOM"** 要看这几项：

```
Cached/Buffers：可回收，不算"真占用"
Slab          ：内核对象（可能泄漏）
Shmem/Tmpfs   ：共享内存/临时文件（占内存且不可回收）
```

```bash
cat /proc/meminfo | grep -E "Slab|SReclaimable|Shmem|Dirty"
```

### 五个"内存看着够却 OOM"

**① 容器有 limit，但宿主机很空**

```
容器 memory limit 512Mi，应用用了 600Mi → cgroup OOM
```

**② 页缓存被计入 cgroup**

```
cgroup v1 下 page cache 也算 → 文件读多就"超限"
（v2 有 memory.low/protection 可缓解）
```

**③ 内存碎片/大页**

```
需要连续大块内存 → 有总量但没有连续块
→ 看 /proc/buddyinfo
```

**④ overcommit 设置**

```
vm.overcommit_memory=2（严格）→ 申请就失败
=0（启发式）→ 可能"先给后杀"
```

**⑤ swap 关闭 + 内存峰值**

```
峰值超过物理内存 → 直接 OOM（无缓冲）
```

### oom_score 怎么算

```
oom_score 高 → 更容易被杀
调整：/proc/<pid>/oom_score_adj（-1000 到 1000）
```

**给关键进程"降低被杀概率"**：

```bash
echo -500 > /proc/$(pidof sshd)/oom_score_adj
```

**"数据库被杀"** → 应该给它更低的 adj（或独立 cgroup）。

### 排查一个真实场景

**现象**：Java 服务每天凌晨被杀。

```
1) dmesg 看到 Killed process java, anon-rss 7.9GB
2) free -m 显示 total 8GB → 确实不够
3) 看 Java 堆配置：-Xmx6g，但堆外（DirectBuffer/元空间）又占 2GB
4) 结论：JVM 总内存 = 堆 + 堆外 + 线程栈 > 8GB
5) 方案：限堆 4g + 限 DirectBuffer + 容器 limit 6Gi
```

**"只看 -Xmx 是不够的"** —— 堆外内存经常是溢出元凶。

### 五个"防 OOM"的实际手段

```
① 容器设 memory limit（并留出余量）
② JVM 用 MaxRAMPercentage + 限 DirectBuffer
③ 关键进程调 oom_score_adj
④ 开 swap（小量，兜底）
⑤ 监控 RSS 趋势（提前发现泄漏）
```

**"RSS 缓慢上涨"** = 泄漏（用趋势图能提前两周发现）。

### 检查清单（cgroup v2）

```bash
cat /sys/fs/cgroup/memory.current
cat /sys/fs/cgroup/memory.max
cat /sys/fs/cgroup/memory.events      # oom / oom_kill
cat /sys/fs/cgroup/memory.stat | head
```

### 检查清单

```
□ 会看 dmesg 里的 Killed process
□ 分清内核 OOM 与 cgroup OOM
□ 会查 Slab/Shmem（不可回收部分）
□ 容器 limit 与应用实际内存匹配
□ JVM 限堆 + 限堆外
□ 关键进程 oom_score_adj 调整
□ 有 RSS 趋势监控
□ 有 swap 兜底（视场景）
□ 有"内存碎片"排查手段（buddyinfo）
□ OOM 事件有告警
```
