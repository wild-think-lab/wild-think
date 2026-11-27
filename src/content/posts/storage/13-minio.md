---
title: MinIO 运维：单机、纠删码集群与"数据到底存哪了"
description: 三种部署形态、mc 常用命令、扩容与修复，以及五个"以为很稳其实很脆"的配置。
date: 2024-12-04
tags: [存储, 对象存储, MinIO]
---

### 三种部署形态

```
① 单机单盘（fs 模式）：仅测试
② 单机多盘（纠删码）：单机也能有冗余
③ 多节点多盘（分布式纠删码）：生产
```

**"单机单盘放生产数据"** 等于没有冗余。

### 纠删码的基本概念

```
N 块盘，M 块冗余 → 可容忍 M 块盘故障
常用 4+2 / 8+4 / 12+4
```

**容量计算**：

```
可用容量 = 总容量 × (N / (N+M))
例：12 块 10TB，EC 8+4 → 可用 120TB × (8/12) = 80TB
```

**"RAID 与纠删码的区别"**：

```
RAID 是盘级，纠删码是对象级（重建只修受损对象，更快）
```

### mc 常用命令

```bash
mc alias set myminio http://minio:9000 AK SK

mc admin info myminio
mc admin heal myminio            # 修复不一致
mc admin scanner trace myminio   # 看扫描进度

mc ls myminio/bucket
mc du myminio/bucket
mc cp file myminio/bucket/
mc mirror --overwrite local/ myminio/bucket/   # 目录同步

mc ilm rule add myminio/bucket --expire-days 30   # 生命周期
mc anonymous set download myminio/bucket/public   # 公共读
mc admin policy attach myminio readwrite --user app
```

### 桶策略与权限

```
① 桶策略（policy）：只读/只写/读写
② 生命周期（ILM）：过期删除/分层到冷存储
③ 版本控制：保留多版本（防误删）
```

**"开版本控制"** 是最便宜的"防误删"方案：

```bash
mc version enable myminio/bucket
```

### 扩容

**分布式 MinIO 的扩容规则（历史版本）**：

```
必须"整组扩容"（server pool 一次加一组）
旧版本不支持"任意加盘"
```

**新版本（2022+）支持"扩容池"**，但要满足：

```
① 新池的盘数与原池一致
② 一次性加入完整的新池
```

**"随便加一块盘"** 是做不动的（架构限制）。

### 五个"以为很稳其实很脆"

**① 用 fs 模式（单盘）**

```
盘坏 = 数据全没
```

**② 所有节点在同一台物理机/同一机柜**

```
电源/网络故障 → 一起挂
```

**③ 没有独立的元数据盘考虑**

```
MinIO 每盘都存数据和元数据 → 盘性能直接影响
→ 不要用 USB/低质量盘
```

**④ 扩容时"新旧节点配置不一致"**

```
盘数不同 / 磁盘大小差异过大 → 拒绝启动或容量浪费
```

**⑤ 没有"定期 heal"**

```
磁盘临时故障恢复后，数据可能不一致
→ 定期 mc admin heal 修复
```

### 常见告警与处理

| 告警 | 含义 | 处理 |
| --- | --- | --- |
| Drive is offline | 盘不可用 | 检查硬件/挂载 |
| Disk usage > 80% | 容量紧张 | 扩容/清理/ILM |
| Healing in progress | 正在修复 | 等待，避免同时扩容 |
| Slow response | 磁盘慢 | 检查 IO/坏盘 |

**"磁盘使用率 > 80% 时写入会变慢"**（纠删码需要空间做校验）。

### 与 K8s/应用集成

```
① 应用直接用 S3 SDK（推荐）
② 作为 Velero / Harbor / Loki 的后端
③ 前置 nginx 做 TLS 与限流
```

**"MinIO 直接暴露公网"** 是常见的安全问题（要前置网关/鉴权）。

### 检查清单

```
□ 生产用纠删码（至少 4+2）
□ 节点分布在不同物理机/机柜
□ 磁盘质量达标（企业级 SSD/HDD）
□ 有独立监控（盘状态/容量/修复）
□ 定期 mc admin heal
□ 开版本控制（防误删）
□ 有 ILM（过期清理/冷热分层）
□ 扩容按"整池"规划
□ 桶策略最小权限
□ 不直接暴露公网
□ 有备份（对象存储不是备份替代品）
```
