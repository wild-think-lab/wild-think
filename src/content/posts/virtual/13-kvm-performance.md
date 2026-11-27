---
title: KVM 性能调优：虚拟机为什么"比物理机慢一截"
description: CPU 绑核、内存大页、磁盘缓存模式、网络 virtio 与 SR-IOV，以及五个"调了没效果"的原因。
date: 2026-11-27
tags: [虚拟化, KVM, 性能]
---

### 先分清四种开销

```
① CPU：上下文切换 / 调度延迟 / 缓存污染
② 内存：EPT 页表遍历 / 大页缺失 / 交换
③ 磁盘：缓存模式 / IO 栈深 / 队列
④ 网络：virtio 软中断 / 中断 CPU
```

**"哪里慢"要先测**（用 fio / iperf / sysbench 分别测）。

### CPU：绑核与拓扑

```xml
<vcpu placement="static">8</vcpu>
<cputune>
  <vcpupin vcpu="0" cpuset="4"/>
  ...
</cputune>
<cpu mode="host-passthrough"/>
```

**要点**：

```
① host-passthrough：暴露宿主机真实 CPU 特性（性能最好）
② 绑核（pin）：避免 vCPU 在物理核之间漂移
③ vCPU 数 ≤ 物理核（同一 NUMA 内）
```

**"vCPU 比物理核多"** → 超卖导致"看起来 CPU 没满但就是慢"（steal time）。

检查 steal：

```bash
top        # 看 %st
```

**"st（steal）高"** = 宿主机没给足 CPU 时间。

### 内存：大页

```xml
<memoryBacking>
  <hugepages/>
</memoryBacking>
```

宿主机预留：

```bash
echo 1024 > /proc/sys/vm/nr_hugepages   # 2M × 1024 = 2GB
grep Huge /proc/meminfo
```

**效果**：

```
减少 EPT/TLB miss → 数据库类负载提升明显（10–20%）
```

**"大页没预留"** → 虚拟机启动失败（"not enough hugepages"）。

### 磁盘：缓存模式

```
none     ：绕过宿主 page cache（推荐，配合后端存储缓存/电池）
writeback：宿主缓存，性能最好但掉电有风险
writethrough：写直达，最安全最慢
unsafe ：忽略 flush（测试用）
```

**实践**：

```
① 本地 SSD + none + 虚拟机内文件系统 journal
② 后端有电池/持久缓存的 RAID → writeback 也可以
③ 不要用 "unsafe" 跑生产
```

**IO 线程与队列**：

```xml
<driver name="qemu" type="raw" cache="none" io="native" discard="unmap"/>
<iothreads>2</iothreads>
```

**"`discard=unmap`"** 支持 TRIM（SSD 场景必要）。

### 网络：virtio 起步，重负载上 SR-IOV

```xml
<interface type="bridge">
  <model type="virtio"/>
  <driver queues="4"/>
</interface>
```

**关键**：

```
① virtio + 多队列（queues = vCPU 数）
② 中断绑核（避免所有网卡中断打到 CPU0）
③ 极高吞吐 → SR-IOV（直通物理网卡 VF）
```

**"网络只有 1/10 带宽"** → 单队列 + 单 CPU 软中断打满。

### 五个"调了没效果"

**① 调错了层**

```
宿主调了磁盘参数，但瓶颈在"虚拟机内文件系统"或"应用"
```

**② NUMA 跨节点**

```
vCPU 与内存不在同一 NUMA → 跨节点访存（延迟翻倍）
```

```xml
<numatune><memnode cellid="0" mode="strict" nodeset="0"/></numatune>
```

**③ 宿主超卖**

```
一台宿主机塞 40 个 vCPU 给 8 核 → 全部变慢
```

**④ 快照/备份在跑**

```
快照链导致写放大 → IO 抖动
```

**⑤ 用了 qcow2 + 无预分配**

```
写时分配 → 首次写慢、碎片多
→ 预分配（qemu-img create -f qcow2 -o preallocation=full）
或直接用 raw + LVM
```

### 一套基准测试

```bash
# CPU
sysbench cpu --threads=8 run
# 内存带宽
sysbench memory --memory-block-size=1M --memory-total-size=10G run
# 磁盘 4K 随机读
fio --name=r --rw=randread --bs=4k --iodepth=32 --size=1G --direct=1 --numjobs=4
# 网络
iperf3 -c <host> -P 4
```

**"和物理机对比跑一遍"** 才知道差多少、差在哪。

### 检查清单

```
□ host-passthrough CPU 模式
□ vCPU 绑核 + 同 NUMA
□ 大页（数据库类负载）
□ 磁盘 cache=none + io=native（本地 SSD）
□ 支持 TRIM（discard=unmap）
□ virtio 多队列 + 中断绑核
□ 高吞吐考虑 SR-IOV
□ 监控 steal time
□ 避免超卖
□ 有与物理机的基准对比
```
