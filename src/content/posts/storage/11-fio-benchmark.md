---
title: 用 fio 测磁盘：怎么测才知道"这块盘到底行不行"
description: 三种负载模型（随机读、顺序写、混合读写）、关键参数含义、结果怎么读，以及五个常见误判。
date: 2026-11-27
tags: [存储, 性能测试, fio]
---

### 先说要测什么

```
不同磁盘擅长的事完全不同：
  NVMe SSD ：随机读（几十万 IOPS）、低延迟
  SATA SSD ：顺序与随机都不错，但队列深度有限
  HDD      ：顺序大吞吐好，随机极差
  云盘     ：受"云厂商限速"影响（IOPS 与带宽有配额）
```

**"这块盘快不快"没有意义，必须说清"在什么负载下"**。

### 三个必备测试模型

**① 随机读（数据库/元数据场景）**

```bash
fio --name=randread --ioengine=libaio --direct=1 \
    --rw=randread --bs=4k --iodepth=32 --numjobs=4 \
    --size=1G --runtime=60 --group_reporting \
    --filename=/dev/nvme0n1
```

**② 顺序写（日志/大数据场景）**

```bash
fio --name=seqwrite --ioengine=libaio --direct=1 \
    --rw=write --bs=1M --iodepth=8 --numjobs=1 \
    --size=4G --runtime=60 --group_reporting \
    --filename=/data/testfile
```

**③ 混合读写（真实业务最接近）**

```bash
fio --name=mixed --ioengine=libaio --direct=1 \
    --rw=randrw --rwmixread=70 --bs=8k --iodepth=32 \
    --numjobs=4 --size=1G --runtime=60 --group_reporting \
    --filename=/dev/nvme0n1
```

**"只测顺序写"是最大的误判来源**：数据库与容器启动都是随机 IO。

### 关键参数逐个解释

| 参数 | 作用 | 建议 |
| --- | --- | --- |
| `--ioengine=libaio` | 异步 IO 引擎 | Linux 必选 |
| `--direct=1` | 绕过 page cache | 测真实设备性能 |
| `--bs` | 块大小 | 4k 随机 / 128k–1M 顺序 |
| `--iodepth` | 队列深度 | 32–128（SSD），1–8（HDD） |
| `--numjobs` | 并发数 | 模拟多线程 |
| `--size` | 每个 job 的数据量 | ≥ 1G（小文件测不出稳态） |
| `--runtime` | 时长 | 60s 起步，30s 前是热身 |
| `--ramp_time` | 热身时间 | 10–30s |
| `--group_reporting` | 汇总输出 | 便于看总 IOPS |

**`--direct=1` 为什么必须**：

```
不加 → 测的是内存速度（page cache）→ 数据虚高几十倍
```

**这是最经典的误测**。

### 结果怎么读

```
read: IOPS=152k, BW=594MiB/s (623MB/s), lat=0.8ms
```

**三个指标**：

```
IOPS  ：每秒 IO 次数（小 block 看这个）
BW    ：带宽（大 block 看这个）
lat   ：延迟（用户感知的关键）
```

**分布比平均值更重要**：

```
clat percentiles (usec):
  50.00th=[  780]
  99.00th=[ 2100]     ← P99
  99.99th=[ 4500]     ← 毛刺
```

**"平均延迟 1ms 但 P99 是 20ms"** → 用户会感知卡顿。

**看 `--lat_percentiles=1` 才能拿到分位数据**。

### 五个常见误判

**① 测的是 page cache**

```
没加 --direct=1 → 测的是内存
```

**② 数据量太小**

```
测 100MB → 全是缓存命中或 SSD 的 SLC 缓存
→ 要测 ≥ 1G，最好接近实际盘容量的一部分
```

**③ 云盘的配额没考虑**

```
云厂商对 IOPS/带宽有上限（如 5000 IOPS）
→ fio 打满了就是"配额上限"，不是"盘的上限"
```

**判断方法**：

```
看云盘规格（不同容量对应不同 IOPS）
如果测试结果 ≈ 规格上限 → 正常
```

**④ 顺序写测 SSD 的"缓存"**

```
消费级 SSD 有 SLC 缓存，写入前几百 MB 极快
超过缓存 → 掉到 QLC 速度（可能只有 100MB/s）
```

**测法**：写超出缓存容量（如 20–50GB 连续写）。

**⑤ HDD 用了 iodepth=32**

```
HDD 无法并行（机械寻道）
→ 高队列深度只会让延迟爆炸，IOPS 不涨
```

**HDD 正确参数**：`--iodepth=1 --numjobs=N`（多进程模拟多用户）。

### 一个"生产验收"的测试组合

```bash
#!/usr/bin/env bash
set -euo pipefail
DEV=${1:?usage: $0 /dev/xxx}

echo "=== 1. 顺序写 1M ==="
fio --name=w --rw=write --bs=1M --iodepth=8 --direct=1 \
    --size=4G --runtime=60 --group_reporting --filename=$DEV

echo "=== 2. 顺序读 1M ==="
fio --name=r --rw=read --bs=1M --iodepth=8 --direct=1 \
    --size=4G --runtime=60 --group_reporting --filename=$DEV

echo "=== 3. 随机读 4k QD32 ==="
fio --name=rr --rw=randread --bs=4k --iodepth=32 --numjobs=4 \
    --size=1G --runtime=60 --group_reporting --filename=$DEV

echo "=== 4. 随机写 4k QD32 ==="
fio --name=rw --rw=randwrite --bs=4k --iodepth=32 --numjobs=4 \
    --size=1G --runtime=60 --group_reporting --filename=$DEV

echo "=== 5. 混合 70/30 ==="
fio --name=mix --rw=randrw --rwmixread=70 --bs=8k --iodepth=32 \
    --numjobs=4 --size=1G --runtime=60 --group_reporting --filename=$DEV
```

**注意：`--filename=$DEV` 会直接写裸设备（数据会丢）**，生产验收用"独立测试盘"或在文件上测。

### 磁盘"看起来快但业务慢"的三个原因

```
① 延迟分布差（P99 高）
② 写放大（SSD 的 GC、RAID 的写惩罚）
③ IO 调度器与队列参数不匹配
```

**检查调度器**：

```bash
cat /sys/block/nvme0n1/queue/scheduler
# NVMe 建议 none（内核自己处理）
# SATA SSD 建议 mq-deadline
# HDD 建议 mq-deadline 或 bfq
```

**RAID 的写惩罚**：

```
RAID5 写一次 = 读旧数据 + 读校验 + 写数据 + 写校验（4 次 IO）
→ RAID5 的随机写性能很差（小规模场景不如 RAID10 或单盘）
```

### 检查清单

```
□ 明确测哪种负载（随机/顺序/混合）
□ 必须 --direct=1
□ 数据量 ≥ 1G（SSD 要测超缓存）
□ 有热身（ramp_time）
□ 看分位延迟（P99/P99.9）
□ HDD 用低队列深度
□ 云盘对照规格上限
□ 检查 IO 调度器
□ 考虑 RAID 写惩罚
□ 生产验收用独立盘（不写裸设备）
□ 测完与实际业务指标对齐
```
