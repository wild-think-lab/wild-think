---
title: Windows Server：企业里躲不开的那一半
description: 为什么公司内网总有几台 Windows Server、版本怎么选、装完先做哪五件事，一次说清。
date: 2021-12-20
tags: [Windows, 系统, 入门, 域控]
---

### 一个不太舒服的事实

不管你在 Linux 上多舒服，进到一家正常的公司，内网一定有 Windows：域控、文件服务器、打印服务器、财务系统、ERP、Exchange……这些不是"历史遗留"，是**商业软件生态决定的**。

所以运维的现实是：Linux 管服务，Windows 管人和权限。

### 版本怎么选

| 版本 | 适合 | 不适合 |
| --- | --- | --- |
| Windows Server Standard | 一般企业、虚拟化、文件与域控 | 大规模私有云（授权按核心算，贵） |
| Windows Server Datacenter | 大量虚拟机、软件定义存储与网络 | 只有一台物理机的小公司 |
| Windows Server Essentials | 5–25 人的小公司，向导式配置 | 超过 25 用户 |
| Windows 10/11 Pro | 临时替代、测试环境 | 正式服务器（授权与并发都不合适） |

**桌面版不能当服务器**：连接数受限、没有 AD DS 角色、更新策略也不同。用桌面版顶服务器，出事只是时间问题。

### 装完先做这五件事

1. **改计算机名**，用能看懂的命名规则（`SH-DC01`、`SH-FS01`），别留随机名。
2. **配静态 IP**，并指向正确的 DNS ——域控自己就是 DNS，这一步错了后面全错。
3. **开远程桌面**（`sysdm.cpl` → 远程），并限制只允许管理网段访问。
4. **装 RSAT / 启用防火墙规则**，别把防火墙整个关掉当作解决方案。
5. **确认时间同步**，域环境里时间偏差超过 5 分钟，Kerberos 认证直接失败。

```powershell
# 常用检查
hostname
ipconfig /all
Get-NetFirewallProfile | Select-Object Name, Enabled
w32tm /query /status
```

### 图形界面之外的真相

Windows 的"点点点"背后全是可以脚本化的：

```powershell
Get-Service | Where-Object Status -eq 'Running'
Get-WindowsFeature | Where-Object Installed
Get-EventLog -LogName System -Newest 20
```

PowerShell 才是 Windows 侧真正的运维入口。界面能做的事，脚本都能做，而且能对一百台机器做。

### 和 Linux 的心智差异

| 维度 | Linux | Windows Server |
| --- | --- | --- |
| 配置方式 | 文本文件 | 注册表 + GUI + PowerShell |
| 权限模型 | 文件 rwx | ACL + 域身份 |
| 服务管理 | systemd | 服务管理器 / `Get-Service` |
| 日志 | 文本文件 | 事件查看器（evtx） |
| 包管理 | apt/dnf | MSI / winget / WSUS |

理解这张表，你就不会拿 Linux 的习惯去硬套 Windows——那是最容易浪费时间的做法。

### 本章要点

- Windows Server 的价值在"商业软件 + 域身份体系"，不是性能。
- 桌面版不能当服务器用。
- 静态 IP + 正确 DNS + 时间同步，是域环境的三块地基。
- PowerShell 是 Windows 侧的自动化入口，别只会点界面。
