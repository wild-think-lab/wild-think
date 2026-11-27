---
title: Windows Server 的 DNS 与 DHCP 角色：域环境里的隐形地基
description: 域控自带 DNS 怎么用、DHCP 授权机制、作用域与保留、以及"域内机器加不进域"的七成原因在这里。
date: 2026-11-27
tags: [Windows, DNS, DHCP, 域控, 网络服务]
---

### 为什么单独讲这两个角色

AD 域的三根柱子是：**DNS、时间同步、Kerberos**。DNS 错了，域就不成立——不是"偶尔出问题"，是根本加不进域。

而且 Windows 的 DHCP 有个 Linux 没有的机制：**授权（Authorization）**，不解开这个，DHCP 服务看着在跑，客户端拿不到地址。

### 域控上的 DNS 要点

域控安装时如果勾了"DNS 服务器"，会自动建区域，并写入 AD 相关记录：

```
_ldap._tcp.dc._msdcs.example.com
_msdcs.example.com
example.com（正向区域，含域控 A 记录）
```

三条必须记住：

1. **域控自己解析自己**：DNS 客户端首选填本机或另一台域控 IP。
2. **不要给域控加公网 DNS 作为首选**：会导致 SRV 记录查不到，加入域失败。
3. **`_msdcs` 区域不能删**：删了域内机器找不到域控。

验证：

```powershell
# 解析是否正常
Resolve-DnsName dc01.example.com
Resolve-DnsName example.com -Type SRV | Select Name, Target
nltest /dsgetdc:example.com

# DNS 客户端配置
Get-DnsClientServerAddress -AddressFamily IPv4 | Select InterfaceAlias, ServerAddresses
```

`nltest /dsgetdc` 能直接告诉你"这台机器认为哪个是域控"，是诊断加入域问题的第一命令。

### DHCP 角色安装与授权

```powershell
Install-WindowsFeature DHCP -IncludeManagementTools

# 关键：授权（否则服务不响应请求）
Add-DhcpServerInDC -DnsName dhcp01.example.com -IPAddress 10.10.10.15

# 创建作用域
Add-DhcpServerv4Scope -Name "Office" -StartRange 10.10.10.100 `
  -EndRange 10.10.10.200 -SubnetMask 255.255.255.0 -LeaseDuration (New-TimeSpan -Hours 10)

# 作用域选项：网关、DNS、域
Set-DhcpServerv4OptionValue -ScopeId 10.10.10.0 -Router 10.10.10.1
Set-DhcpServerv4OptionValue -ScopeId 10.10.10.0 -DnsServer 10.10.10.13,10.10.10.14
Set-DhcpServerv4OptionValue -ScopeId 10.10.10.0 -DnsDomain example.com
```

授权状态检查：

```powershell
Get-DhcpServerInDC
Get-DhcpServerv4Scope
Get-DhcpServerv4Lease -ScopeId 10.10.10.0 | Select -First 5
```

### 保留与排除

- **保留（Reservation）**：按 MAC 绑定固定 IP，适合打印机、投影、门禁。
- **排除（Exclusion）**：把静态 IP 段从池里排除，避免冲突。

```powershell
Add-DhcpServerv4ExclusionRange -ScopeId 10.10.10.0 -StartRange 10.10.10.100 -EndRange 10.10.10.120
Add-DhcpServerv4Reservation -ScopeId 10.10.10.0 -IPAddress 10.10.10.150 `
  -ClientId 00-11-22-33-44-55 -Description "printer-3f"
```

### 七成"加不进域"的原因

排查顺序（按命中率）：

1. **客户端 DNS 指向公网**：`ipconfig /all` 看 DNS 服务器。指向 114.114.114.114 必失败。
2. **时间偏差 > 5 分钟**：`w32tm /query /status`，Kerberos 对时间极敏感。
3. **域控 DNS 里没有客户端记录**：DHCP 没配 DNS，或客户端手工设了错误 DNS。
4. **网络不通 389/88/445 端口**：`Test-NetConnection dc01 -Port 389`。
5. **计算机账号已存在但密码错**：`Reset-ComputerMachinePassword`。
6. **OU 权限不足**：普通用户默认只能把机器加入默认 Computers 容器。

对应命令：

```powershell
ipconfig /all
w32tm /query /status
Test-NetConnection dc01.example.com -Port 389
Test-NetConnection dc01.example.com -Port 88
nltest /dsgetdc:example.com
dcdiag /test:dns /v
```

`dcdiag /test:dns` 是域控侧最全面的 DNS 自检，值得跑一次存档。

### 高可用

- DNS：**至少两台域控都装 DNS**，区域随 AD 复制；客户端首选/备用分别指向两台。
- DHCP：Windows Server 2012+ 支持 **DHCP 故障转移**（成对模式），或拆分作用域（80/20）。

```powershell
Add-DhcpServerv4Failover -ComputerName dhcp01 -PartnerServerName dhcp02 `
  -ScopeId 10.10.10.0 -ServerRole Active -SharedSecret (Read-Host -AsSecureString)
```

### 运维清单

```powershell
# 每日
Get-DhcpServerv4Statistics
Get-DhcpServerv4Scope | Select Name, StartRange, EndRange, SubnetMask

# 每周
Get-DhcpServerv4Lease -ScopeId 10.10.10.0 | Measure-Object | Select Count
dcdiag /test:dns

# 变更后
Get-DhcpServerv4OptionValue -ScopeId 10.10.10.0
```

### 一句总结

域环境里的故障，**先看 DNS，再看时间，最后看权限**。这三条按顺序查，能省掉 80% 的盲目试错。
