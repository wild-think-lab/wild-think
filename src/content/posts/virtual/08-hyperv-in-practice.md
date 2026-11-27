---
title: Hyper-V 实战：Windows 上的虚拟化怎么配才不踩坑
description: 启用条件、虚拟交换机三种模式、与 VMware 的冲突、动态内存与检查点、以及"虚拟机网络不通"的排查顺序。
date: 2026-11-27
tags: [Windows, Hyper-V, 虚拟化, 网络]
---

### 启用条件

```
① CPU 支持 VT-x/AMD-V，且 BIOS 里开启
② 系统为 Windows 10/11 专业版、企业版或 Server（家庭版无 Hyper-V 管理器）
③ 内存 ≥ 8G（跑两台以上建议 16G+）
```

检查：

```powershell
systeminfo | Select-String "Hyper-V"
# 需要看到 "已检测到虚拟机监控程序" 或 四项均为 是
Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
```

启用：

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All
# 重启后
Get-VM
```

**注意**：启用 Hyper-V 后，宿主机会被 Hypervisor 接管，**VMware Workstation 老版本、VirtualBox 会变慢或无法启动**（新版能用但性能下降）。装 WSL2 也会启用 Hyper-V。

### 虚拟交换机三种模式

| 类型 | 行为 | 适用 |
| --- | --- | --- |
| 外部（External） | 绑定物理网卡，VM 与局域网同网段 | 需要被局域网访问的 VM |
| 内部（Internal） | 宿主机与 VM 互通，不连外网 | 纯内网实验 |
| 私有（Private） | 只有 VM 之间互通，宿主机也不行 | 隔离测试 |

创建外部交换机：

```powershell
New-VMSwitch -Name "ExtNet" -NetAdapterName "以太网" -AllowManagementOS $true
```

**`-AllowManagementOS $true` 是关键**：否则创建交换机后宿主机会失去网络（远程连不上）。

内部网络做 NAT：

```powershell
New-VMSwitch -Name "LabNet" -SwitchType Internal
New-NetIPAddress -IPAddress 192.168.100.1 -PrefixLength 24 -InterfaceAlias "vEthernet (LabNet)"
New-NetNat -Name "LabNat" -InternalIPInterfaceAddressPrefix 192.168.100.0/24
```

VM 内设 192.168.100.10/24，网关 192.168.100.1。

### "虚拟机网络不通"的排查顺序

```powershell
# 1. VM 连的是哪个交换机
Get-VMNetworkAdapter -VMName "vm1" | Select SwitchName, IPAddresses

# 2. 交换机类型对不对（外部交换机绑的是哪块网卡）
Get-VMSwitch | Select Name, SwitchType, NetAdapterInterfaceDescription

# 3. 宿主机上的 vEthernet 适配器状态
Get-NetAdapter | Where Name -like "vEthernet*" | Select Name, Status

# 4. VM 内是否拿到 IP（DHCP 或静态）
```

四个常见原因：

| 原因 | 表现 |
| --- | --- |
| 交换机绑定错网卡 | 宿主机能上网，VM 不能 |
| 忘记 `-AllowManagementOS` | 建交换机后宿主机断网 |
| 公司网络限制 MAC | VM 无法获取 DHCP |
| VM 内防火墙 | 能被 ping 但不能访问端口 |

### 动态内存与静态内存

```powershell
# 动态内存（适合测试环境）
Set-VM -Name "vm1" -DynamicMemory -MemoryMinimumBytes 2GB -MemoryStartupBytes 4GB -MemoryMaximumBytes 8GB

# 静态内存（适合数据库等稳定负载）
Set-VM -Name "vm2" -StaticMemory -MemoryStartupBytes 8GB
```

**动态内存不适合**：数据库（缓存会被压缩）、需要预留大页的应用、对延迟敏感的服务。

### 检查点（快照）

```powershell
Checkpoint-VM -Name "vm1" -SnapshotName "before-upgrade"
Get-VMSnapshot -VMName "vm1"
Restore-VMSnapshot -VMName "vm1" -Name "before-upgrade" -Confirm:$false
Remove-VMSnapshot -VMName "vm1" -Name "old"
```

**检查点不是备份**：它存在同一块磁盘上，磁盘坏了全丢。生产 VM 做检查点会显著增加 IO（AVHDX 链）。

建议：

- 做完关键操作前打一个检查点。
- 确认没问题后**合并（删除）检查点**，别留一堆。
- 需要长期保留 → 导出或备份到其他介质。

### 磁盘：动态扩展 vs 固定

```powershell
New-VHD -Path D:\vhd\vm1.vhdx -SizeBytes 50GB -Dynamic
New-VHD -Path D:\vhd\vm2.vhdx -SizeBytes 50GB -Fixed
```

| | 动态扩展 | 固定 |
| --- | --- | --- |
| 初始占用 | 小 | 等于设定大小 |
| 性能 | 略低（有扩展开销） | 高 |
| 空间回收 | 需手动 `Optimize-VHD` | 不需要 |

数据库类 VM 用固定盘。动态盘用完删除数据后**空间不会自动回收**，需要：

```powershell
Optimize-VHD -Path D:\vhd\vm1.vhdx -Mode Full
```

（需要先关机）

### 一个可用的内网实验配置

```powershell
# 1. 内网交换机 + NAT
New-VMSwitch -Name LabNet -SwitchType Internal
New-NetIPAddress -IPAddress 192.168.100.1 -PrefixLength 24 -InterfaceAlias "vEthernet (LabNet)"
New-NetNat -Name LabNat -InternalIPInterfaceAddressPrefix 192.168.100.0/24

# 2. 建两台 VM（示例，实际可用 ISO 安装）
New-VM -Name node1 -MemoryStartupBytes 4GB -NewVHDSizeBytes 40GB -NewVHDPath D:\vhd\node1.vhdx -SwitchName LabNet
New-VM -Name node2 -MemoryStartupBytes 4GB -NewVHDSizeBytes 40GB -NewVHDPath D:\vhd\node2.vhdx -SwitchName LabNet

# 3. 启动并安装系统（挂 ISO）
Add-VMDvdDrive -VMName node1 -Path D:\iso\ubuntu-22.04.iso
Start-VM node1
```

VM 内设置静态 IP 192.168.100.11/12，网关 192.168.100.1，DNS 8.8.8.8 → 能上网且互相能通。

### 检查清单

```
□ BIOS 开了虚拟化，系统是专业版及以上
□ 外部交换机创建时加了 -AllowManagementOS
□ 内网实验用 Internal + NAT，不要乱绑物理网卡
□ 数据库类 VM 用静态内存 + 固定盘
□ 检查点用完就合并，别当备份
□ 与 VMware/VirtualBox 共存时注意性能下降
```
