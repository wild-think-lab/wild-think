---
title: Linux 性能排查四件套：负载高到底是 CPU、内存还是 IO
description: 用 uptime/vmstat/iostat/pidstat 在 5 分钟内分清瓶颈类型，附真实输出解读与常见误判。
date: 2026-11-27
tags: [Linux, 性能, 排障, 负载, IO]
---

### 第一步：分清"负载"的三种含义

```bash
uptime
# 15:20:01 up 32 days,  3 users,  load average: 12.44, 9.10, 4.32
```

load average 是**可运行 + 不可中断（D 状态）进程数**的平均值。它不是 CPU 使用率。

- load 高、CPU 空闲 → 多半卡在 **IO 或锁**（进程在 D 状态等磁盘）。
- load 高、CPU 也满 → 计算密集型。
- load 低但响应慢 → 可能是**单个请求内部等待**（外部依赖慢），不是系统负载问题。

先看一个数字：`nproc`（核数）。load ≈ 核数 表示队列基本满；超过 2 倍就该查了。

### 第二步：vmstat 定位资源类型

```bash
vmstat 1 5
```

```
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu------
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 8  3      0 120034  21000 890221    0    0  1204  3902 2201 5120 12  4 78  6  0
```

读法（只记四个字段）：

- `r`：等待 CPU 的进程数，持续 > 核数 → CPU 不足。
- `b`：不可中断睡眠进程数，持续 > 0 → IO 或存储卡住。
- `si/so`：swap 换入换出，非 0 就是**内存不足**（最严重）。
- `wa`：IO 等待占比，长期 > 20% → 存储瓶颈。

`si/so` 非零时不要再谈 CPU 优化，先解决内存。

### 第三步：iostat 看是谁在压磁盘

```bash
iostat -xz 1 3
```

```
Device   r/s     w/s   rkB/s   wkB/s  await  aqu-sz  %util
sda    120.0  3400.0    960   54000   12.4    2.10   98.3
```

- `%util` 接近 100% → 设备饱和。
- `await` 高（> 20ms 对 SSD 已异常）→ 队列等待严重。
- `aqu-sz` 大 → 请求堆积。

配合 `pidstat -d 1` 看是哪个进程在写：

```bash
pidstat -d -p ALL 1 3
```

钉住元凶后：日志刷盘？备份任务？还是 `fsync` 太频繁？

### 第四步：CPU 到底被谁吃了

```bash
top -b -n1 -o %CPU | head -15
pidstat -u 1 3
mpstat -P ALL 1 3        # 看是否单核打满（单线程瓶颈）
```

关键区分：

- **`us` 高**：应用计算密集。查代码、查算法、查 GC。
- **`sy` 高**：系统调用多。常见于大量小文件 IO、网络包处理、频繁 fork。
- **单核 100%、其他核空闲**：单线程瓶颈，加机器没用，要改架构或开多进程。
- **`st` 高**：虚拟机被宿主抢占，找云厂商。

### 内存与 swap

```bash
free -h
cat /proc/meminfo | egrep 'MemAvailable|SwapTotal|SwapFree|Dirty'
smem -t -k | tail -5          # 按进程实际占用
```

`MemAvailable` 才是可用内存（`free` 里的 free 不含可回收的 cache，容易误判）。

`Dirty` 持续偏高 → 写回跟不上，IO 即将恶化。

### 网络是否参与其中

```bash
ss -s                          # 连接状态汇总
ss -tnp state established | wc -l
sar -n DEV 1 3                 # 网卡吞吐
ping -c 10 <目标>              # 延迟抖动
```

连接数异常多（如 2 万 established 但业务量不大）→ 连接泄漏或短连接未复用。

### 一张判断表

| 现象 | 主因 | 下一步 |
| --- | --- | --- |
| load 高、`wa` 高、`%util` 100% | 磁盘饱和 | 查 `pidstat -d`、慢日志、备份窗口 |
| `si/so` 非 0 | 内存不足 | 查泄漏（`smem`、堆 dump）、加内存 |
| `r` 远大于核数、`us` 高 | CPU 不足 | 查算法/GC、扩容、限流 |
| 单核 100% | 单线程瓶颈 | 多进程/多线程改造 |
| load 低但接口慢 | 外部依赖 | 查下游 RT、超时设置、连接池 |
| `sy` 高 | 系统调用多 | 查文件数、网络配置（`somaxconn`） |

### 一个真实的误判

"服务器很慢，load 8，8 核，CPU 使用 90%"——一查发现是**备份任务在跑**，`tar` 压缩吃满所有核。业务其实正常。

教训：**先问"现在在跑什么任务"**，再看指标。定时任务、日志切割、数据库备份、`yum update` 都会造成周期性负载尖峰，和"性能退化"完全是两件事。

### 落地建议

1. 部署一套基础采集：node_exporter + 看板（load、CPU、内存、磁盘、网络各一张）。
2. 排障按固定顺序：load → vmstat → iostat → pidstat，别乱猜。
3. 记录每次故障的"指标快照"，半年后你会有一份自己的案例库。
4. 定时任务错峰：备份别和业务高峰重叠，这是最低成本的优化。
