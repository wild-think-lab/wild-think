---
title: IO 诊断：iostat 里那几列到底说明什么
description: r/s、await、util、aqu-sz 的读法，四个"IO 慢"的真实原因，以及五个"换了 SSD 还是慢"的误区。
date: 2026-11-27
tags: [Linux, 性能, IO]
---

### 先看四列

```bash
iostat -x 1
```

```
r/s, w/s    ：每秒读/写次数（IOPS）
rKB/s,wKB/s ：吞吐
await       ：平均等待时间（ms）—— 最关键
%util       ：设备繁忙百分比
aqu-sz      ：平均队列长度
```

**判读顺序**：

```
① await 是否高（> 10ms 对 SSD 就偏高）
② 是读还是写高
③ 队列长不长（aqu-sz）
④ util 是否接近 100
```

**"util 100% 但 await 低"** → 设备被"忙"但不是"慢"（SSD 常见，正常）。

**"await 高 + util 低"** → 可能是队列上层/文件系统/锁的问题。

### 四个"IO 慢"的真实原因

**① 随机小 IO 太多**

```
4K 随机读 → 磁盘最怕这种
→ 检查应用是否"逐条查/逐行读"
```

**② 队列深度太浅**

```
单线程同步 IO → 队列只有 1 → 延迟完全暴露
→ 用 iodepth（批量/异步）
```

**③ 写放大**

```
RAID5 写、COW 文件系统、快照链 → 一次逻辑写变成多次物理写
```

**④ 刷脏页风暴**

```bash
grep -i "dirty\|writeback" /proc/meminfo
```

**"周期性卡顿（每几秒一次）"** → 脏页回写引起的风暴。

```bash
# 观察
vmstat 1
# 看 wa（IO 等待）与 bo（写块）
```

### 定位"是谁在 IO"

```bash
iotop -oP                  # 按进程
pidstat -d 1               # 按进程的 IO
```

**"iostat 高但 iotop 看不到进程"**：

```
① 内核本身（刷脏页）
② NFS/网络存储（走网络栈）
③ 被容器隔离（看宿主机视角）
```

### 文件系统层面的三种检查

```bash
# 1) 是否 ext4 且碎片多
e4defrag -c /data
# 2) 是否用了 "relatime"
mount | grep data
# 3) 是否有大量小文件
find /data -type f | wc -l
```

**"百万小文件"** 会让目录遍历与备份极慢。

### 五个"换了 SSD 还是慢"

**① 瓶颈在网络存储**

```
NFS/iSCSI 的延迟在"网络 + 服务端"，本地 SSD 无关
```

**② 瓶颈在文件系统**

```
ext4 单目录百万文件 / 大目录 list
```

**③ 瓶颈在应用**

```
每次读 1 字节、循环 100 万次 → 是代码问题
```

**④ 没开队列/异步**

```
fio 测出来很快，应用还是慢 → 因为应用是同步单线程
```

**⑤ 云盘/共享存储的 IOPS 上限**

```
云盘类型决定 IOPS 上限（不是"SSD 就一定快"）
```

**"云上"要查"盘类型 + IOPS 配额"**，这是硬限制。

### 一套对比测试

```bash
# 顺序大块（吞吐上限）
fio --name=seq --rw=read --bs=1M --size=2G --direct=1
# 随机 4K（IOPS）
fio --name=rand --rw=randread --bs=4k --iodepth=32 --numjobs=4 --size=1G --direct=1
# 混合读写（真实场景）
fio --name=mix --rw=randrw --rwmixread=70 --bs=8k --iodepth=16 --size=1G --direct=1
```

**"顺序快、随机慢"** → 典型机械盘/低端云盘特征。

### 检查清单

```
□ 会读 await/aqu-sz/util
□ 分清"忙"与"慢"
□ 用 iotop/pidstat 定位进程
□ 检查脏页回写（周期性卡顿）
□ 注意到 RAID5/快照的写放大
□ 查云盘 IOPS 配额
□ 文件系统不是瓶颈（大目录/碎片）
□ 应用侧用批量/异步 IO
□ 有 fio 基线（顺序/随机/混合）
□ 有 IO 延迟监控（不只 util）
```
