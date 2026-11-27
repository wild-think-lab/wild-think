---
title: Windows 服务器卡顿与蓝屏：从现象到定位
description: 蓝屏 dump 分析、性能计数器、常见卡顿的六个来源、五个"重启就好了"的假象。
date: 2026-11-27
tags: [Windows, 运维, 故障]
---

### 两类问题

```
① 蓝屏（BSOD）：系统直接崩 → 看 dump
② 卡顿/变慢：系统活着但慢 → 看计数器与进程
```

**"重启好了"** 只说明没有定位，问题会再来。

### 蓝屏：三件事

```
① 记录停止代码（0x000000XX）
② 找 dump 文件（C:\Windows\MEMORY.DMP 或 Minidump）
③ 用 WinDbg / BlueScreenView 看"谁触发的"
```

```powershell
# 确认 dump 配置
Get-WmiObject Win32_OSRecoveryConfiguration |
  Select-Object DebugFilePath, DebugInfoType
```

**常见停止码**：

| 停止码 | 典型原因 |
| --- | --- |
| 0x7E | 驱动未处理异常（第三方驱动） |
| 0xD1 | 驱动访问错误内存（驱动 bug） |
| 0x9F | 电源/驱动挂起（休眠相关） |
| 0x50 | 内存页错误（内存条/驱动） |
| 0x133 | 硬件看门狗（超时/CPU 过热） |
| 0xEF | 启动设备不可访问（引导/存储） |

**"最近装了什么驱动"** → 90% 的蓝屏是驱动引入的。

### WinDbg 最小用法

```
!analyze -v
```
看 `MODULE_NAME` / `IMAGE_NAME` / `FAILURE_BUCKET_ID`。

**"ntoskrnl.exe"** 往往是"被别的驱动带崩"，要继续看调用栈。

### 卡顿：六个来源

```
① CPU：单核打满 / 线程争抢
② 内存：分页/换页频繁（Pagefile 命中）
③ 磁盘：队列长（avg disk queue > 2）
④ 网络：重传/丢包
⑤ 进程：某进程句柄泄漏/GC
⑥ 驱动：老驱动在高负载下崩
```

### 关键计数器（性能监视器）

```
Processor(_Total)\% Processor Time
Processor(_Total)\% Interrupt Time      # 硬件中断多 → 驱动/网卡
System\Processor Queue Length           # > CPU 核数 × 2 → 排队
Memory\Available MBytes
Memory\Pages/sec                        # 高 → 内存不足
PhysicalDisk(_Total)\Avg. Disk sec/Read # > 20ms → 磁盘慢
PhysicalDisk(_Total)\Current Disk Queue Length
Network Interface\Output Queue Length
```

```powershell
# 快速看
Get-Counter '\Processor(_Total)\% Processor Time','\Memory\Available MBytes','\PhysicalDisk(_Total)\Avg. Disk sec/Read' -SampleInterval 2 -MaxSamples 5
```

### 找"谁在吃资源"

```powershell
# CPU Top
Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name,Id,CPU,WS

# 句柄最多
Get-Process | Sort-Object HandleCount -Descending | Select-Object -First 10 Name,HandleCount

# 线程数
Get-Process | Sort-Object Threads.Count -Descending | Select-Object -First 5 Name,@{n='Threads';e={$_.Threads.Count}}
```

### 内存泄漏的判据

```
进程 Working Set 持续上涨（几小时级）
私有字节（Private Bytes）也在涨
重启进程后回落 → 泄漏
```

```powershell
Get-Process -Name app | Select-Object Name, WS, PrivateMemorySize64, HandleCount
```

### 磁盘慢的常见原因

```
① 机械盘随机 IO（换 SSD）
② RAID 卡缓存策略（WriteBack vs WriteThrough）
③ 杀毒软件实时扫描（排除业务目录）
④ 快照/备份在跑
⑤ 动态磁盘/存储空间（额外开销）
```

### 五个"重启就好了"的假象

**① 内存泄漏**

```
重启释放 → 明天又涨回来
```

**② 句柄泄漏**

```
同上（看 HandleCount 趋势）
```

**③ 驱动状态坏**

```
重启重置 → 高负载再来
```

**④ 磁盘队列堆积**

```
重启清空队列 → 峰值再来
```

**⑤ 定时任务冲突**

```
两个备份任务撞在一起 → 每天固定时间卡
```

### 一次"标准动作"

```
1) 记录现象与时间（是否固定时段）
2) 看事件日志（系统/应用，Error/Warning）
3) 计数器采样 5–10 分钟
4) Top 进程（CPU/内存/句柄）
5) 查"最近变更"（补丁/驱动/软件）
6) 有 dump 就分析 dump
7) 结论落到"具体组件 + 具体改法"
```

```powershell
Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2; StartTime=(Get-Date).AddHours(-24)} |
  Select-Object -First 20 TimeCreated,Id,ProviderName,Message
```

### 检查清单

```
□ dump 已启用（不是"仅小内存转储"就够，关键机器要完整）
□ 有性能计数器基线
□ 有 Top 进程采集脚本
□ 知道"最近变更"记录
□ 驱动有版本管理（不用"最新就好"）
□ 杀毒有业务目录排除
□ 定时任务时间错开
□ 有事件日志集中收集
□ 蓝屏有分析流程（不停在"重启"）
□ 重启前留证据
```
