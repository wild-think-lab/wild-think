---
title: RAID 与磁盘速查
summary: 各级别 RAID 的空间与容错、重建风险、家用/企业盘的取舍，以及"磁盘故障"的判断流程。
group: storage
order: 3
tags: [RAID, 磁盘, 存储]
---

### RAID 级别对比

| 级别 | 最少盘 | 空间利用率 | 容错 | 随机写性能 | 适合 |
| --- | --- | --- | --- | --- | --- |
| RAID0 | 2 | 100% | 0（一盘坏全丢） | 最好 | 临时/缓存 |
| RAID1 | 2 | 50% | 1 盘 | 读快写一般 | 系统盘、小容量高可靠 |
| RAID5 | 3 | (n-1)/n | 1 盘 | 差（写惩罚 4 次） | 大容量顺序读 |
| RAID6 | 4 | (n-2)/n | 2 盘 | 更差（6 次） | 大容量、重建窗口长 |
| RAID10 | 4 | 50% | 视布局（可 1–2） | 最好 | 数据库、高 IOPS |
| JBOD | 1 | 100% | 0 | 单盘 | 分布式存储（软件层做副本） |

**"RAID5 的随机写惩罚"**：

```
每写 1 个逻辑块 → 读旧数据 + 读旧校验 + 写新数据 + 写新校验 = 4 次物理 IO
→ 小随机写场景比单盘还慢
```

**这就是"数据库不要用 RAID5"的原因**。

### 空间与容错的实际算法

```
RAID5：可用 = (n-1) × 单盘容量
RAID6：可用 = (n-2) × 单盘容量
RAID10：可用 = n/2 × 单盘容量
```

**"8 块 4TB 做 RAID5"**：

```
可用 28TB，容错 1 盘
重建时 28TB 全盘扫描（可能几小时到几天）
```

**重建期间再坏一块 → 全丢**。**这是 RAID5 的最大风险**（尤其大容量 HDD）。

**所以大容量场景更推荐 RAID6 或 RAID10**。

### URE（不可恢复读错误）

```
企业级 HDD 的 URE 指标：10^15（约每读 1PB 出现一次）
消费级：10^14（约每读 125TB 出现一次）
```

**"重建必须读全盘"**：

```
8 块 4TB RAID5 重建要读 28TB
消费级盘的 URE 概率 → 重建失败概率不低
```

**这就是"家用盘组 RAID5 很危险"的数学原因**。

### 硬件 RAID vs 软件 RAID

| 维度 | 硬件 RAID（阵列卡） | 软件 RAID（mdadm/ZFS） |
| --- | --- | --- |
| 性能 | 有缓存与专用芯片 | 吃 CPU（现代 CPU 够用） |
| 电池/掉电保护 | 有（BBU/超级电容） | 无（但 ZFS 有事务保证） |
| 可移植性 | 绑定阵列卡（卡坏要同型号） | 盘拿到别的机器直接识别 |
| 管理 | 厂商工具 | mdadm/zpool 命令 |
| 成本 | 高 | 低 |

**"阵列卡坏了要买同型号"是硬件 RAID 的长期风险**。

**建议**：

```
① 数据库：硬件 RAID10 + BBU，或 NVMe 直连 + 软件副本
② 大容量归档：RAID6 或分布式存储（软件副本）
③ 千万别用"主板自带的 FakeRAID"
```

### 磁盘故障判断流程

```bash
# 1. SMART 健康
smartctl -a /dev/sda | grep -E "Reallocated|Pending|Uncorrectable|Health"
```

**关键三项**：

```
Reallocated_Sector_Ct      已重映射扇区（>0 要警惕，增长说明恶化）
Current_Pending_Sector     待映射（>0 说明读不稳）
Offline_Uncorrectable      无法修复（>0 基本可换盘）
```

**"SMART 通过"不代表没问题**：

```
很多盘在"SMART 全绿"的状态下突然死
→ 要结合"增长趋势"与"IO 错误日志"
```

```bash
# 2. 内核 IO 错误
dmesg -T | grep -iE "error|reset|ata|nvme" | tail -50
journalctl -k --since -1h | grep -i "I/O error"

# 3. 性能异常
iostat -x 1 5      # 看 await / %util / r_await
```

**`await` 持续 > 50ms（HDD）或 > 5ms（SSD）** 说明盘或链路有问题。

### 重建与替换

```bash
# mdadm 替换流程
cat /proc/mdstat                     # 看当前状态
mdadm --manage /dev/md0 --fail /dev/sdb1 --remove /dev/sdb1
mdadm --manage /dev/md0 --add /dev/sdc1
cat /proc/mdstat                     # 看 recovery 进度
```

**注意**：

```
① 重建期间性能会明显下降（限速可选）
② 重建期间尽量不要再做重 IO 操作
③ 大容量盘重建可能数十小时（要有心理准备）
```

**限速（mdadm）**：

```bash
echo 50000 > /proc/sys/dev/raid/speed_limit_max
```

### ZFS 的几个要点

```bash
zpool status              # 池状态
zpool list                # 容量
zfs list                  # 数据集
zpool scrub tank          # 校验（定期做）
```

**RAIDZ 对比**：

```
raidz1 ≈ RAID5（1 盘容错）
raidz2 ≈ RAID6（2 盘容错）
mirror ≈ RAID10（成对镜像）
```

**ZFS 的关键优势**：

```
① 校验和（能发现静默损坏并修复）
② 快照与克隆（几乎零成本）
③ 压缩与去重（可选，去重吃内存要谨慎）
```

**注意**：

```
① ZFS 不建议"raidz 扩容"（加盘不能扩 raidz 的容量，只能扩池）
② 需要 ECC 内存（非必须但强烈建议）
③ 去重（dedup）表很吃内存，普通场景别开
```

### 一个"选盘"的判断表

| 场景 | 推荐 |
| --- | --- |
| 数据库（高 IOPS） | 企业级 SSD（NVMe），RAID10 或副本 |
| 日志/顺序写 | 企业级 SSD 或 HDD，RAID10/RAID6 |
| 大容量归档 | 企业级 HDD（CMR 不 SMR），RAID6 |
| 备份 | 大容量 HDD，单盘 + 校验（或对象存储） |
| 虚拟机 | 企业级 SSD，RAID10 |

**"消费级 SMR 盘"是性能陷阱**：

```
SMR（叠瓦）盘随机写极慢，重建时间极长
→ 便宜但会让你怀疑人生
```

**判断方法**：查型号规格书，或看"持续写超缓存后的速度"（掉到 10MB/s 级别基本是 SMR）。

### 检查清单

```
□ 数据库不用 RAID5
□ 大容量盘用 RAID6 或 RAID10（考虑重建风险）
□ 企业级盘（不用消费级组 RAID5）
□ 确认盘不是 SMR
□ 硬件 RAID 记录阵列卡型号（备件）
□ 用 mdadm 的会看 /proc/mdstat
□ 配 SMART 监控（三项关键指标 + 趋势）
□ 定期 scrub/校验（ZFS 尤其）
□ 重建时限速，避免叠加压力
□ 有"盘坏"的替换流程与备件
```
