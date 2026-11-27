---
title: Windows 域控排错：五类"用户登不进去"的定位法
description: 加域失败、登录慢、信任关系丢失、GPO 不生效、时间不同步，五类症状对应的五条命令链。
date: 2024-09-27
tags: [Windows, AD, 域控, 排错]
---

### 总原则：先看客户端，再看网络，最后看 DC

```
① 客户端能不能解析域名
② 客户端能不能连 DC 的 389/88/445/3268
③ 客户端时间是否与 DC 一致（差 > 5 分钟 Kerberos 必失败）
④ 再看 DC 自身的健康（复制、DNS、SYSVOL）
```

**Kerberos 的时间容忍是 5 分钟**，这是最常见的"莫名其妙登不进去"。

### 症状一：加域失败

```powershell
# 1. 解析 DC
nslookup _ldap._tcp.dc._msdcs.example.com
# 必须由 AD 的 DNS 返回 SRV 记录

# 2. 端口连通
Test-NetConnection dc01.example.com -Port 389
Test-NetConnection dc01.example.com -Port 88
Test-NetConnection dc01.example.com -Port 445
Test-NetConnection dc01.example.com -Port 3268

# 3. 时间
w32tm /stripchart /computer:dc01.example.com /samples:3

# 4. 实际加域的错误
Add-Computer -DomainName example.com -Credential (Get-Credential) -Verbose
```

**常见根因**：

```
① 客户端 DNS 指向了路由器/公网 DNS（解析不到 SRV）→ 最最常见
② 防火墙挡了 88/389
③ 时间差 > 5 分钟
④ 计算机账号已存在（重装系统后同名机器）
```

**计算机账号冲突的处理**：

```powershell
# 在 DC 上删掉旧账号（或用 dsrm）
Remove-ADComputer -Identity OLD-PC01 -Confirm:$false
```

### 症状二：登录特别慢（超过 1 分钟）

```powershell
# 看登录各阶段耗时
Get-WinEvent -LogName 'Microsoft-Windows-GroupPolicy/Operational' |
  Where-Object { $_.Id -in 4001,4002,4003,4004,4005,4006,4007 } |
  Select-Object TimeCreated, Id, Message -First 20
```

**关键事件**：

```
4001 开始处理计算机策略
4004 计算机策略处理完成
4005 开始处理用户策略
4006 用户策略处理完成
```

`4001→4004` 或 `4005→4006` 间隔很长 = GPO 处理慢。

**其他慢的根因**：

```
① 漫游配置文件太大（几百 MB 从服务器拉）
② 登录脚本里有网络等待（映射一个不可达的驱动器）
③ DNS 反查超时（正向能解析，反向不行 → 每个连接都等 5 秒）
④ 组策略里的"软件安装"在拉大 MSI
```

**DNS 反查是最好的"隐形杀手"**：

```powershell
# 检查是否有 PTR 记录
Resolve-DnsName 10.0.0.5 -Type PTR
```

没有 PTR 时，很多服务（包括 SMB）会等超时。

### 症状三：信任关系丢失（The trust relationship between this workstation and the primary domain failed）

**现象**：机器能开机，但登录报信任关系失败。

**根因**：计算机账号的密码（机器账号密码）与 DC 上不同步（常见于快照回滚、克隆虚拟机）。

**修法一（推荐，不用退域加域）**：

```powershell
# 在客户端用本地管理员登录，然后：
Test-ComputerSecureChannel -Verbose
# 若 False：
Test-ComputerSecureChannel -Repair -Credential (Get-Credential)
```

`-Repair` 会重置机器账号密码，通常 30 秒解决。

**修法二（传统）**：

```powershell
# 退域再加域（会丢本地配置，慎用）
Remove-Computer -UnjoinDomainCredential (Get-Credential) -Force
Add-Computer -DomainName example.com -Credential (Get-Credential)
Restart-Computer
```

**为什么会发生**：

```
① 虚拟机从快照恢复（机器密码回到旧版本）
② 克隆虚拟机（两台机器同一 SID/密码）
③ 长时间离线（机器密码默认 30 天轮换，DC 上已更新）
```

**克隆虚拟机的正确做法**：sysprep（`sysprep /generalize /oobe /shutdown`）。

### 症状四：GPO 不生效

```powershell
# 1. 看实际应用了哪些策略
gpresult /h C:\temp\gp.html
# 打开 HTML 看"已应用的 GPO"与"被拒绝的 GPO"

# 2. 强制刷新
gpupdate /force

# 3. 看事件日志
Get-WinEvent -LogName 'Microsoft-Windows-GroupPolicy/Operational' -MaxEvents 30
```

**`gpresult` 里的"被拒绝（Denied）"最有用**：它会告诉你"为什么没生效"（通常是 WMI 筛选或安全组筛选）。

**四个常见原因**：

```
① 策略链接到错误的 OU
② WMI 筛选不匹配（如筛选了 Windows 10 但机器是 11）
③ 安全组筛选没包含该机器/用户
④ SYSVOL 没同步（改完策略但 DC 之间没复制）
```

**检查 SYSVOL 复制**：

```powershell
# 在 DC 上
repadmin /replsummary
repadmin /showrepl
# 或
dcdiag /test:sysvolcheck
```

**GPO 客户端缓存**：默认 90 分钟刷新（±30 分钟随机）。改完策略后要 `gpupdate /force` 或等。

### 症状五：时间不同步

```powershell
# 看当前时间源
w32tm /query /status
w32tm /query /configuration

# 手动同步
w32tm /resync /force

# 改成指定 NTP
w32tm /config /manualpeerlist:"ntp1.example.com,0x8" /syncfromflags:manual /reliable:yes /update
Restart-Service w32time
```

**域环境的时间层级**：

```
PDC Emulator（域内时间源）→ 外部 NTP（或硬件时钟）
其他 DC → PDC
成员机 → 登录的 DC
```

**给成员机配置时间源是错的做法**：应该让它们跟着 DC 走（域内自动）。

**检查时间层级**：

```powershell
w32tm /monitor
```

### DC 自身健康检查

```powershell
# 全面诊断
dcdiag /v /c /q

# 复制状态
repadmin /replsummary
repadmin /showrepl

# DNS 注册检查
dcdiag /test:dns /v
```

**`dcdiag` 会检查**：连通性、复制、DNS 注册、FSMO、SPN、时间。

**最常见的 DC 问题**：

```
① DNS 记录缺失（_ldap._tcp SRV 没了）
   → 重启 netlogon 服务会自动重建：Restart-Service Netlogon
② 复制失败（防火墙挡了 RPC 动态端口）
   → 改用固定端口或用 AD 站点复制工具排查
③ SYSVOL 不同步（DFSR 或 FRS 故障）
```

**"重启 Netlogon 重建 SRV"是排障的第一步神技**：

```powershell
Restart-Service Netlogon
Start-Sleep 5
nslookup -type=SRV _ldap._tcp.dc._msdcs.example.com
```

### 检查清单

```
□ 客户端 DNS 指向 AD DNS（不是路由器）
□ 88/389/445/3268 端口通
□ 客户端与 DC 时间差 < 5 分钟
□ DC 有 PTR 记录
□ 登录慢先查 GPO 事件 4001–4006 的间隔
□ 信任关系用 Test-ComputerSecureChannel -Repair
□ GPO 先看 gpresult 的"Denied"原因
□ 改完 GPO 用 gpupdate /force
□ DC 定期跑 dcdiag 与 repadmin /replsummary
□ SRV 记录缺失先重启 Netlogon
□ 克隆虚拟机必须 sysprep
```
