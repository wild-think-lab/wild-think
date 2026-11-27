---
title: WSUS 补丁管理：从审批环到"补丁打不上"的排查
description: WSUS 角色部署、组策略下发、审批环与维护窗口怎么定、磁盘与清理、PowerShell 报表，以及常见失败码对应的处理办法。
date: 2023-01-01
tags: [WSUS, Windows, 补丁管理, 域控, GPO]
---

### 手工打补丁的问题在哪

每个月第二个周二（Patch Tuesday）之后，微软会放出一批更新。如果靠"每台机器自己点更新"：

- 一批机器装了、一批没装，版本长期处于"半补丁"状态；
- 有台机器装完重启失败，没人知道；
- 补丁把某个业务系统弄崩了，也没法追溯到"哪天哪台先装"。

WSUS 的价值：**集中下载一次、按组审批、控制重启时间、记录状态**。

### 部署角色

```powershell
Install-WindowsFeature -Name UpdateServices -IncludeManagementTools
& "C:\Program Files\Update Services\Tools\WsusUtil.exe" postinstall CONTENT_DIR=D:\WSUS
```

`CONTENT_DIR` 必须放在有空间的独立盘上。经验值：**每 1000 台客户端约 30–60GB**（取决于保留多少分类与语言）。

IIS 侧不需要额外配置，但要确认 `WsusPool` 的专用内存限制被设成了 0（否则大同步会 503）：

```powershell
# 已知问题：WSUS 应用池默认私有内存上限 5MB 左右，会在同步时崩
Import-Module WebAdministration
Set-ItemProperty IIS:\AppPools\WsusPool -Name recycling.periodicRestart.privateMemory -Value 0
```

### 分类与产品：先做减法

新手最容易犯的错是全选。分类里只勾：

- `Critical Updates`、`Security Updates`、`Definition Updates`（可选）、`Service Packs`（可选）、`Update Rollups`
- 产品只勾你实际在用的：Windows Server 2016/2019/2022、Windows 10/11、Office 对应版本、SQL Server 对应版本

`Drivers`、`Feature Packs`、`Tools` 一律不勾——它们体积大且容易出兼容问题。

同步计划设成每天凌晨一次，自动审批规则只用于"定义更新"，其余全部手动。

### 组策略下发

```
计算机配置 → 管理模板 → Windows 组件 → Windows 更新
```

四行关键配置：

```ini
# 指定 Intranet Microsoft 更新服务位置
WUServer        = http://wsus.corp.local:8530
WUStatusServer  = http://wsus.corp.local:8530

# 自动更新行为：3 = 自动下载并通知安装（最可控）
NoAutoUpdate    = 0
AUOptions       = 3

# 客户端目标组名（WSUS 侧建同名组）
TargetGroupName = "Ring1-Pilot"
```

命令行等效（便于脚本化）：

```powershell
$wsus = "http://wsus.corp.local:8530"
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' -Name WUServer -Value $wsus
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' -Name WUStatusServer -Value $wsus
```

**端口注意**：WSUS 走 8530（HTTP）/ 8531（HTTPS），不是 80/443。防火墙只放 80 是常见的第一坑。

### 审批环（Ring）

别一次性全推。分三环：

| 环 | 成员 | 审批时间 | 目的 |
| --- | --- | --- | --- |
| Ring 0 | 测试机、IT 自己 | 周三 | 先踩坑 |
| Ring 1 | 非关键业务服务器 | 周五 | 观察 48h |
| Ring 2 | 生产核心、域控 | 下周二+维护窗口 | 最后推 |

域控单独走一环，且**不要和其他角色同批重启**。

审批用 PowerShell 批量做，比在控制台点快得多：

```powershell
$wsus = Get-WsusServer
$group = $wsus.GetComputerTargetGroups() | Where-Object Name -eq 'Ring1-Pilot'
$updates = $wsus.GetUpdates() | Where-Object { $_.Title -match '2026-11' -and $_.IsApproved -eq $false }

foreach ($u in $updates) {
    $u.Approve($group, 'Install')
}
```

### 清理：不打理一定会爆盘

WSUS 的日志和过期更新会越积越多。每月做一次：

```powershell
# 1. 拒绝已过期/被取代的更新（先看清单再执行）
Get-WsusUpdate | Where-Object { $_.UpdateClassificationTitle -ne 'Critical Updates' } |
  Where-Object { $_.IsSuperseded -eq $true } | ForEach-Object { $_.Update.Approve('Declined') }

# 2. 服务端清理向导（等价于 UI 里的 Server Cleanup Wizard）
Invoke-WsusServerCleanup -CleanupObsoleteUpdates -CleanupUnneededContentFiles `
  -CompressUpdates -DeclineExpiredUpdates -DeclineSupersededUpdates
```

清理前**先备份 WSUS 数据库**（WID 或 SQL 都行），清理向导偶尔会把正在用的内容文件一起删掉，之后客户端会重新下载（不至于出错，但会突然流量暴涨）。

### 客户端状态报表

```powershell
# 哪台机器多久没上报了（超过 30 天基本是掉线）
$wsus = Get-WsusServer
$wsus.GetComputerTargets() |
  Select-Object FullDomainName, LastReportedStatusTime, LastSyncTime,
    @{n='Days';e={[int]((Get-Date) - $_.LastReportedStatusTime).TotalDays}} |
  Where-Object Days -gt 30 | Sort-Object Days -Descending | Format-Table -AutoSize
```

生产上建议把这个变成每日邮件报表，比每月临时查一次有效得多。

### "补丁打不上"按失败码查

客户端 `Get-WUHistory` / `Get-WUInstall` 的报错码：

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| 0x8024401C | 连不上 WSUS（超时） | 检查 8530 端口、代理、`WUServer` 拼写 |
| 0x8024402C | 名称解析失败 | DNS 里没有 `wsus.corp.local` 记录 |
| 0x80240034 | 下载失败 | 检查 `CONTENT_DIR` 空间与 IIS 应用池状态 |
| 0x80248007 | 元数据缺失 | 客户端 `wuauclt /resetauthorization /detectnow` 重新注册 |
| 0x80070005 | 权限被拒 | 客户端对 `%windir%\SoftwareDistribution` 无权限，或 GPO 冲突 |
| 0x8024D007 | 客户端版本过低 | 先装最新的 Windows Update Agent |

现场排查手势：

```powershell
Get-WUHistory -MaxEvents 20 | Select Date, Title, Result
Get-Service wuauserv, bits
Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' | Select WUServer
# 强制重新检测
wuauclt /resetauthorization /detectnow
# 还是不行就清缓存（会重新下载，慎用）
net stop wuauserv; net stop bits
Remove-Item "$env:windir\SoftwareDistribution" -Recurse -Force
net start wuauserv; net start bits
```

### 补丁装完为什么要重启两次

很多"Critical"更新是**分两阶段**的：先替换文件到 pending 状态，重启后进入第二阶段完成注册。只重启一次会出现"已安装但状态仍为 pending"，配合 `Get-WUHistory` 看起来像没装成功。维护窗口至少要留两次重启的时间，或者用 `-ForceRestart` 分两次执行。

### 一句话总结

WSUS 的可用性不在"能推补丁"，而在**审批环、维护窗口、掉线监控**这三件事的纪律。
