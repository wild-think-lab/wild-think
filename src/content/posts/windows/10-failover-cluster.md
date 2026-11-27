---
title: Windows 故障转移集群：SQL Server 与文件共享的高可用
description: 集群的三个层次、仲裁（Quorum）为什么最容易配错、共享存储的硬要求、故障切换的验证方式，以及"裂脑"的预防。
date: 2026-11-27
tags: [Windows, 集群, 高可用, SQLServer]
---

### 三个层次

```
① 存储层：共享存储（SAN/iSCSI/共享文件夹）
② 集群层：Windows Server Failover Cluster（WSFC）
③ 应用层：SQL Server 故障转移集群 / 文件服务器角色 / Hyper-V
```

**WSFC 本身不是高可用**：它只提供"资源组切换"的机制，能不能真的切要看应用是否支持（比如普通文件共享可以，MySQL 不行）。

### 前置条件

```
① 域环境（至少两个域控，集群节点加入同一域）
② 至少两台节点，同版本 OS
③ 共享存储（iSCSI LUN 或 SAN）
④ 每个节点两张网卡（一公一私，私网做心跳）
⑤ 固定 IP 若干（集群 IP + 角色 IP）
```

**为什么必须加域**：集群需要统一的身份与 Kerberos 认证。工作组模式做不了。

### 网络规划

```
公网（业务）：10.0.0.11 / 10.0.0.12
私网（心跳）：10.0.1.11 / 10.0.1.12
集群 IP：     10.0.0.20
文件服务 IP： 10.0.0.21
```

心跳网卡要：

```
- 放在独立交换机或直连（避免业务流量抖动影响心跳）
- 关闭 NetBIOS、关闭文件共享
- 优先级低于公网（PowerShell: Set-NetIPInterface -InterfaceMetric）
```

### 仲裁（Quorum）最容易配错

**仲裁决定"集群还活着吗"**：多数派存活才提供服务。

| 节点数 | 推荐仲裁模式 |
| --- | --- |
| 2 节点 | **节点 + 文件共享见证**（或用云见证） |
| 3 节点 | 节点多数（Node Majority） |
| 4 节点 | 节点 + 文件见证 |
| 跨站点 | 站点感知 + 文件见证放在第三方站点 |

**2 节点不留见证最危险**：

```
节点 A 与节点 B 网络断开（但都活着）
→ 两边都认为对方挂了 → 都尝试接管共享存储
→ 双方各写同一个 LUN → 数据损坏（这就是裂脑）
```

加了文件共享见证后，只有能访问见证的那一方胜出。

配置：

```powershell
# 查看当前仲裁
Get-ClusterQuorum

# 2 节点 + 文件共享见证
Set-ClusterQuorum -NodeAndFileShare majority `
  -FileShareWitnessPath "\\fs01\clusterwitness"

# 或云见证（Azure Blob）
Set-ClusterQuorum -CloudWitness -AccountName xxx -AccessKey xxx -Endpoint core.windows.net
```

### 共享存储的硬要求

```
① 同一 LUN 同一时间只能被一个节点挂载（除非是集群感知的文件系统）
② LUN 要以"集群磁盘"的形式加入（Get-ClusterResource 里能看到 Physical Disk）
③ 多路径（MPIO）要配置（避免单 HBA 故障）
④ 磁盘签名唯一（克隆 VM 时容易重复 → 集群无法识别）
```

**克隆虚拟机做集群节点时，磁盘签名冲突是高频坑**：

```powershell
# 查看磁盘签名
Get-ClusterResource | Where ResourceType -eq "Physical Disk" | Get-ClusterParameter DiskSignature
```

### 建集群

```powershell
# 1. 验证
Test-Cluster -Node node1,node2 -Include "Storage"

# 2. 创建
New-Cluster -Name sqlcluster -Node node1,node2 -StaticAddress 10.0.0.20 -NoStorage

# 3. 加入磁盘
Get-ClusterAvailableDisk | Add-ClusterDisk

# 4. 加见证
Set-ClusterQuorum -NodeAndFileShare majority -FileShareWitnessPath "\\fs01\witness"
```

### SQL Server 故障转移集群（FCI）

要点：

```
① 数据库文件放在共享存储（不在本地盘）
② SQL Server 服务用集群资源方式管理
③ 实例 IP 是集群角色 IP（客户端连这个）
④ 切换时数据库会短暂不可用（分钟级）
```

**FCI 与 AlwaysOn 的区别**（高频问题）：

| | FCI | AlwaysOn AG |
| --- | --- | --- |
| 存储 | 共享存储（一份） | 各自本地存储（多份） |
| 故障切换 | 整个实例切换 | 数据库级切换 |
| 读扩展 | 无 | 有（只读副本） |
| 成本 | 需要共享存储 | 需要更多本地存储 |

现在更推荐 AlwaysOn AG（不依赖共享存储，支持读扩展）。

### 文件服务器角色

```powershell
Add-ClusterFileServerRole -Name filesvc -Storage "Cluster Disk 1" -StaticAddress 10.0.0.21
```

客户端访问 `\\filesvc\share` 或 `\\10.0.0.21\share`，切换后 IP 漂移，客户端无感（但 DNS 缓存可能有延迟）。

### 切换验证（必须做）

```powershell
# 1. 主动切换
Move-ClusterGroup -Name "SQL Server (INSTANCE)" -Node node2

# 2. 模拟故障（强制断电）
# 在 node1 直接关机（不要优雅关闭，那不算故障切换）
# 观察：
Get-ClusterGroup
Get-ClusterNode

# 3. 验证业务
# 客户端连接 10.0.0.21，执行查询
```

**只做"主动切换"不算验证**：主动切换是优雅的，多数问题出现在"突然断电"。

### 裂脑的预防

```
① 仲裁配置正确（2 节点必有见证）
② 心跳网独立（不与业务共用）
③ 共享存储的 SCSI 预留（Persistent Reservation）必须工作
④ 交换机层避免"两边互相看不见但都能看到存储"
⑤ 有监控：两个节点同时报告自己是 Owner → 立即告警
```

监控：

```powershell
# 集群事件里的关键 ID
# 1177: 集群网络分区（裂脑前兆）
# 1069: 资源失败
# 1146: 节点被移出
```

### 检查清单

```
□ 域环境，两个域控
□ 心跳网独立且优先级低
□ 2 节点集群有见证（文件共享或云）
□ LUN 磁盘签名唯一
□ MPIO 已配置
□ 只做"主动切换"验证是不够的，要测断电
□ 集群事件 1177 有告警
□ 客户端连接的是角色 IP 而不是节点 IP
```
