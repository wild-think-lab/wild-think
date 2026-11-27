---
title: Windows 安全基线：服务器装完先做这十二项
description: 账号、审计、远程、补丁、服务、共享与 PowerShell 的安全配置，每项配可执行的命令。
date: 2025-07-11
tags: [Windows, 安全, 基线]
---

### 十二项清单（按优先级）

```
① 本地管理员组收窄
② 禁用不必要账户（Guest）
③ 开启审计策略
④ 远程访问加固（RDP 不暴露公网）
⑤ 补丁与 Defender
⑥ 关闭高危服务（SMBv1/Telnet 等）
⑦ 共享与权限
⑧ PowerShell 日志
⑨ 屏幕锁定与密码策略
⑩ 时间同步
⑪ 日志集中
⑫ 备份与快照
```

### ① 本地管理员组

```powershell
Get-LocalGroupMember -Group Administrators
```

**要点**：

```
① 只保留必要账户（含域管理员组）
② 不要"每个运维一个本地管理员"
③ 日常账号不放管理员组
```

### ② 禁用/删除无用账户

```powershell
Disable-LocalUser -Name Guest
Get-LocalUser | Where-Object Enabled
```

**"测试用的本地账号还开着"** 是最常见的后门。

### ③ 审计策略

```powershell
auditpol /set /category:"登录/注销" /success:enable /failure:enable
auditpol /set /category:"账户登录" /success:enable /failure:enable
auditpol /set /category:"对象访问" /success:enable /failure:enable
auditpol /get /category:* | Select-String "无"
```

**必须开的四类**：

```
登录事件、账户管理、对象访问（关键目录）、策略变更
```

**"没审计 = 出事查不到"**。

### ④ RDP 加固

```powershell
# 不用 RDP 就直接关
Set-ItemProperty "HKLM:\System\CurrentControlSet\Control\Terminal Server" -Name fDenyTSConnections -Value 1

# 必须用时
Set-ItemProperty "HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" -Name UserAuthentication -Value 1  # NLA
Set-ItemProperty "HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" -Name PortNumber -Value 3389
```

**要点**：

```
① 绝对不把 3389 暴露公网（前置 VPN/堡垒机）
② 开 NLA（网络级认证）
③ 限制来源 IP
```

**"3389 直接对公网"** 是勒索软件最爱的入口。

### ⑤ 补丁与 Defender

```powershell
Get-MpComputerStatus | Select AMServiceEnabled, RealTimeProtectionEnabled
Get-HotFix | Sort-Object InstalledOn -Descending | Select -First 5
```

```powershell
Set-MpPreference -DisableRealtimeMonitoring $false
Update-MpSignature
```

**"为了性能关掉 Defender"** 是常见但危险的做法。

### ⑥ 关闭高危协议与服务

```powershell
Disable-WindowsOptionalFeature -Online -FeatureName SMB1Protocol -NoRestart
Get-Service | Where-Object {$_.Status -eq 'Running'} | Select Name, DisplayName
```

**必须关的**：

```
SMBv1、Telnet 客户端、LLMNR（组策略）、不必要的 IIS/FTP
```

**"SMBv1 开着"** 是永恒之蓝类漏洞的前提。

### ⑦ 共享与权限

```powershell
Get-SmbShare
Get-SmbShareAccess -Name <share>
```

**"Everyone 完全控制"** 是最常见的问题。

```powershell
Revoke-SmbShareAccess -Name share -AccountName Everyone -Force
Grant-SmbShareAccess -Name share -AccountName "Domain\Ops" -AccessRight Change -Force
```

### ⑧ PowerShell 日志

```powershell
# 组策略开启（推荐）：
# 计算机配置 → 管理模板 → Windows 组件 → PowerShell
#   Turn on Module Logging（4103）
#   Turn on PowerShell Script Block Logging（4104）
```

**"4104 脚本块日志"** 是排查恶意脚本的关键。

### ⑨ 密码与锁屏

```powershell
net accounts
# 最短密码长度、锁定阈值、锁定时长
```

```powershell
net accounts /minpwlen:8 /lockoutthreshold:5 /lockoutduration:30 /lockoutwindow:30
```

**"锁定阈值 0"** 意味着"可以无限试密码"。

### ⑩ 时间同步

```powershell
w32tm /query /status
w32tm /resync
```

**"时间差 > 5 分钟"** 会导致域认证/Kerberos 失败。

### ⑪ 日志集中

```
Windows 事件转发（WEF）或 转发到 syslog/日志平台
重点：安全日志（4624/4625/4672/4720）
```

**"只看本地事件查看器"** → 出事时机器可能已经不可用。

### ⑫ 备份

```
系统状态备份 / 卷影副本 / 虚拟机快照（不是唯一手段）
关键配置导出（GPO/注册表）
```

### 五个"基线做完还是有洞"

```
① 只做了"新机器"，老机器没补
② 组策略被本地策略覆盖（gpresult 看谁赢）
③ 域管理员日常登录工作站（凭据泄露）
④ 服务账号权限过大
⑤ 没有"变更后复查"（补丁/新装软件又开了端口）
```

### 检查清单

```
□ 管理员组最小化
□ 无用账户已禁用
□ 审计策略开启（登录/账户/对象/策略）
□ RDP 不暴露公网 + NLA
□ Defender 开启 + 特征更新
□ SMBv1 关闭
□ 共享权限不用 Everyone
□ PowerShell 日志开启
□ 密码策略 + 锁定阈值
□ 时间同步正常
□ 日志集中（安全事件）
□ 有备份与配置导出
□ 定期复查（含老机器）
□ 域管理员分层（不日常登录）
```
