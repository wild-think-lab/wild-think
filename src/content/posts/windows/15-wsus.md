---
title: WSUS 补丁管理：为什么总有机器打不上补丁
description: WSUS 的分层结构与组策略配置、常见"补丁不下发/装失败"的五类原因，以及替代方案。
date: 2026-11-27
tags: [Windows, 补丁, WSUS]
---

### 结构

```
WSUS 服务器 → 客户端通过组策略找到它 → 下载"已批准的更新"
```

**关键概念**：

```
① 计算机组（按 OU/手动分）
② 审批（Approval：批准哪些更新给哪些组）
③ 同步（从上游 Microsoft 同步元数据）
④ 清理（过期更新要定期清理，否则库膨胀）
```

### 组策略配置

```
计算机配置 → 管理模板 → Windows 组件 → Windows 更新
  指定 Intranet Microsoft 更新服务位置
    http://wsus.example.com:8530
  配置自动更新        → 4（自动下载并计划安装）
  自动更新检测频率    → 22 小时
  目标组名称          → 生产服务器
```

**`目标组名称`** 决定机器进哪个 WSUS 组（组策略覆盖）。

**"没设目标组"** → 全部进 Unassigned Computers（无法按组审批）。

### 五个"补丁不下发/装失败"

**① 客户端找不到 WSUS**

```powershell
# 客户端检查
Get-ItemProperty HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU
gpresult /h c:\gp.html     # 确认策略生效
wuauclt /reportnow         # 强制上报
```

**常见原因**：

```
① 组策略没生效（OU 范围错/继承被阻止）
② 8530 端口不通（80 是 8531 的 SSL）
③ 客户端用的是"Windows Update"而不是 WSUS（策略被本地覆盖）
```

**② 更新未审批**

```
同步来了 → 但没人审批 → 客户端看不到
→ 按组审批，或用"自动审批规则"
```

**③ 补丁装不上（错误码）**

| 错误码 | 含义 |
| --- | --- |
| 0x8024401c | 与 WSUS 通信超时（网络/负载） |
| 0x80244022 | WSUS 服务不可用（IIS 池/内存） |
| 0x80248007 | 元数据过期 |
| 0x80070005 | 权限不足 |
| 0x800f081f | 组件存储缺失（需 DISM 修复） |

**"0x8024401c"** 最常见（WSUS 性能不足/客户端太多）。

**④ WSUS 库过大/未清理**

```
多年不清理 → SUSDB 几十 GB → 审批与同步极慢
```

```powershell
# WSUS 清理向导（或用脚本）
Invoke-WsusServerCleanup -CleanupObsoleteUpdates -CleanupUnneededContentFiles `
  -CompressUpdates -DeclineExpiredUpdates -DeclineSupersededUpdates
```

**"每月跑一次清理"** 是必须的运维动作。

**⑤ 客户端卡在"下载 0%"**

```
① BITS 服务异常
② 磁盘空间不足
③ 代理/防火墙拦截
```

```powershell
net stop wuauserv
net stop bits
Remove-Item C:\Windows\SoftwareDistribution -Recurse -Force
net start bits
net start wuauserv
```

**"清 SoftwareDistribution"** 是客户端侧最常用的重置手段。

### 服务器侧的容量注意

```
① WSUS 需要 IIS + WID/SQL
② 每 1000 客户端约需 100GB 内容存储（视补丁）
③ SUSDB 用 SQL 时要调索引维护
④ 内存不足会导致 IIS 池回收（客户端报 0x80244022）
```

**"WSUS 跑在低配虚拟机上"** 是很多单位补丁失败的根本原因。

### 替代/补充方案

```
① Microsoft Intune / Configuration Manager（现代方案）
② 云上"更新环"（Windows Update for Business）
③ 第三方补丁管理（如 ManageEngine Patch Manager）
④ 脚本化（PSWindowsUpdate 模块）
```

**"WSUS 仍然是本地 AD 环境的默认选择"**，但要接受它的运维成本。

### 一个"月度补丁窗口"流程

```
1) 每月第二个周二后同步（Patch Tuesday）
2) 周三：在"测试组"审批并安装
3) 周五：验证测试组无异常（业务/事件日志）
4) 次周一：审批"生产组"，非核心时段安装
5) 一周后：检查未安装清单，逐个排查
6) 记录：本次补丁清单、失败机器、原因
```

**"测试组先上"** 是避免"补丁打出事故"的关键。

### 检查清单

```
□ 组策略指向 WSUS + 设目标组
□ 客户端能上报（wuauclt /reportnow 有效）
□ 8530/8531 端口通
□ 有审批流程（测试组 → 生产组）
□ 每月跑清理向导
□ SUSDB 有维护计划（索引/收缩）
□ WSUS 服务器资源充足（内存/磁盘）
□ 有"未安装补丁"清单与跟进
□ 有补丁窗口与回滚预案
□ 记录每次补丁结果（失败原因归档）
```
