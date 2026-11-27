---
title: IIS 运维：503 与"应用程序池莫名回收"
description: 五个最常见故障（503/500/池回收/端口冲突/权限）、日志位置与排查顺序。
date: 2026-11-27
tags: [Windows, IIS, 运维]
---

### 日志在哪

```
IIS 访问日志：C:\inetpub\logs\LogFiles\W3SVC1\
HTTPERR     ：C:\Windows\System32\LogFiles\HTTPERR\
事件查看器  ：Windows Logs → Application（W3SVC / WAS 来源）
应用日志    ：应用自己的 log（.NET 常见在 inetpub 或 App_Data）
```

**"HTTPERR 里的 503"** 能看到"因为什么被拒"（如 `QueueFull`、`Timer_ConnectionIdle`）。

### ① 503 Service Unavailable

```
原因排序：
① 应用程序池停止（崩溃/回收/手动）
② 队列满（请求量超过池处理能力）
③ 应用启动失败（配置错误/依赖缺失）
④ 站点绑定/端口冲突
```

**排查**：

```powershell
Get-WebAppPoolState -Name "MyPool"
Get-WebSiteState
Get-WebBinding
# 事件日志
Get-EventLog -LogName Application -Source WAS -Newest 20
```

**"池显示 Started 但 503"**：

```
可能是"快速失败保护"（Rapid-Fail Protection）把池停了
→ 事件日志有 "Rapid Fail Protection triggered"
```

### ② 500 Internal Server Error

```
① 代码异常（最直接，看应用日志）
② .NET 配置错误（web.config 语法）
③ 权限（连接数据库失败）
④ 模块/处理程序缺失（IIS 功能未安装）
```

**打开详细错误**：

```xml
<configuration>
  <system.webServer>
    <httpErrors errorMode="Detailed" existingResponse="PassThrough"/>
  </system.webServer>
  <system.web>
    <customErrors mode="Off"/>
  </system.web>
</configuration>
```

**"生产别开 Detailed"** → 改完记得恢复（否则泄露堆栈）。

### ③ 应用程序池莫名回收

```
① 默认 1740 分钟定时回收
② 虚拟内存/私有内存超阈值回收
③ 配置变更（web.config 改动 → 池重启）
④ 依赖的二进制更新（bin 目录改动）
⑤ 崩溃（w3wp.exe 异常退出）
```

**检查**：

```powershell
Get-EventLog -LogName Application -Source WAS -Newest 30 |
  Where-Object {$_.Message -match "recycle|shutdown"}
```

**"配置了内存阈值"**：

```xml
<recycling>
  <periodicRestart memory="2000000" privateMemory="1500000"/>
</recycling>
```

**"想彻底避免回收"** → 关定时回收需谨慎（内存泄漏会累积）。

**"30 分钟就重启一次"** → 通常是内存阈值太低或真有泄漏。

### ④ 端口冲突

```powershell
netstat -ano | findstr :80
Get-Process -Id <pid>
```

**"IIS 起不来，80 被占"**：

```
① 其他 IIS 站点（主机头冲突）
② 第三方程序（如某些客户端/服务）
③ 系统保留端口（Hyper-V 动态端口范围占用）
```

```powershell
netsh int ipv4 show excludedportrange protocol=tcp
```

**"Hyper-V 占用 80/443"** 是 Windows 上很隐蔽的一类问题。

### ⑤ 权限问题

```
现象：本地能跑，IIS 上 500/401
原因：应用池标识（ApplicationPoolIdentity）无权限
```

```powershell
# 查池标识
Get-ItemProperty IIS:\AppPools\MyPool | Select processModel
# 给目录权限
icacls "C:\sites\app" /grant "IIS AppPool\MyPool:(OI)(CI)M"
```

**"用了 NetworkService/自定义账号"** → 权限与凭据都要单独确认。

### 一个"排查顺序"

```
1) 事件日志（WAS/W3SVC）→ 池是否被停/回收
2) 池状态 + 站点状态
3) 应用日志（500 的具体异常）
4) netstat（端口）
5) 权限（池标识对目录/DB）
```

**"先看事件日志"** 能解决大部分。

### 常用命令（PowerShell）

```powershell
Import-Module WebAdministration
Get-Website
Get-WebAppPoolState -Name *
Restart-WebAppPool -Name "MyPool"
Start-Website -Name "Default Web Site"
Get-WebConfigurationProperty -Filter /system.applicationHost/sites -Name Collection
```

### 检查清单

```
□ 知道访问日志/HTTPERR/事件日志位置
□ 会看池状态与回收原因
□ 快速失败保护已了解
□ 内存阈值配置合理
□ 端口冲突排查（含 Hyper-V 保留）
□ 池标识权限正确
□ 有"池回收"监控
□ 有应用日志接入
□ 生产不长期开 Detailed 错误
□ 有备份（配置 + 站点）
```
