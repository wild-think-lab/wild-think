---
title: PowerShell 运维：比 Bash 更适合 Windows 的那一半
description: 对象管道与 Bash 文本流的差异、批量管理服务与日志、远程执行、错误处理的坑，以及五个常用运维脚本。
date: 2024-01-09
tags: [Windows, PowerShell, 自动化, 运维]
---

### 核心差异：对象 vs 文本

```bash
# Bash：一切是文本，靠 grep/awk 切
ps aux | grep nginx | awk '{print $2}'
```

```powershell
# PowerShell：管道传对象，直接取属性
Get-Process nginx | Select-Object -ExpandProperty Id
```

这个差异决定了 PowerShell 不需要 `awk`：**要什么属性就取什么属性**。

### 五个常用脚本

**① 批量重启服务并等待就绪**

```powershell
$svcs = 'W3SVC','MSSQLSERVER'
foreach ($s in $svcs) {
    Restart-Service -Name $s -Force -ErrorAction Stop
    $deadline = (Get-Date).AddMinutes(2)
    while ((Get-Service $s).Status -ne 'Running' -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
    }
    "{0} => {1}" -f $s, (Get-Service $s).Status
}
```

**② 找占满磁盘的目录**

```powershell
Get-ChildItem C:\ -Directory | ForEach-Object {
    $size = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue |
             Measure-Object Length -Sum).Sum
    [pscustomobject]@{ Path = $_.FullName; GB = [math]::Round($size/1GB, 2) }
} | Sort-Object GB -Descending | Select-Object -First 10
```

**③ 日志按时间过滤 + 聚合错误**

```powershell
Get-Content D:\logs\app.log -Tail 5000 |
  Where-Object { $_ -match 'ERROR|FATAL' } |
  ForEach-Object {
      if ($_ -match 'ERROR\s+(\w+):') { $matches[1] }
  } | Group-Object | Sort-Object Count -Descending | Select-Object -First 10
```

**④ 远程批量执行**

```powershell
$servers = 'srv01','srv02','srv03'
Invoke-Command -ComputerName $servers -ScriptBlock {
    [pscustomobject]@{
        Host   = $env:COMPUTERNAME
        Disk   = [math]::Round((Get-PSDrive C).Free/1GB, 1)
        Uptime = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
        Svc    = (Get-Service W3SVC).Status
    }
} | Format-Table -AutoSize
```

前提：WinRM 已启用（`Enable-PSRemoting -Force`），且有权限。

**⑤ 计划任务替代 cron**

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
           -Argument '-NoProfile -File D:\scripts\healthcheck.ps1'
$trigger = New-ScheduledTaskTrigger -Daily -At 06:30
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
Register-ScheduledTask -TaskName 'DailyHealthCheck' -Action $action `
  -Trigger $trigger -Principal $principal
```

**用 SYSTEM 账户**：避免"用户没登录任务不跑"的问题。

### 错误处理的三个坑

**① `-ErrorAction` 的默认是 Continue**

```powershell
# 默认：出错继续执行，脚本"看起来成功"
Remove-Item C:\x -ErrorAction SilentlyContinue   # 静默失败

# 想要失败就停
$ErrorActionPreference = 'Stop'
```

**② `try/catch` 抓不到非终止错误**

```powershell
try {
    Get-ChildItem C:\notexist -ErrorAction Stop   # 必须加 Stop
} catch {
    "failed: $($_.Exception.Message)"
}
```

**③ 外部 exe 的退出码不会被 try/catch 捕获**

```powershell
& robocopy $src $dst /MIR
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }
```

`$LASTEXITCODE` 才是判断外部程序成败的地方。

### 输出格式：别用 Write-Host 塞数据

```powershell
# 差：Write-Host 输出的是文本，不能被下游处理
Write-Host "disk=50"

# 好：输出对象
[pscustomobject]@{ Host='srv01'; DiskFreeGB=50 } |
  Export-Csv D:\report.csv -NoTypeInformation -Encoding UTF8
```

原则：**脚本之间传对象，只在最后一步格式化给人看**。

### 远程与凭据

```powershell
# 交互式凭据
$cred = Get-Credential
Invoke-Command -ComputerName srv01 -Credential $cred -ScriptBlock { hostname }

# 使用当前凭据（域环境）
Invoke-Command -ComputerName srv01 -ScriptBlock { hostname }

# 测试连通
Test-WSMan srv01
```

跨域/工作组要额外配置（TrustedHosts、HTTPS 监听），域环境最省事。

### 五个"少踩坑"的习惯

```
① 脚本开头写 Set-StrictMode -Version Latest
② 变量名用 $PascalCase 风格，与内置变量区分
③ 路径一律用 -LiteralPath（防通配符）
④ 中文字符文件用 UTF8BOM 保存（否则乱码）
⑤ 危险操作用 -WhatIf 先跑一遍
```

`-WhatIf` 示例：

```powershell
Remove-Item D:\old\* -Recurse -WhatIf
# What if: Performing the operation "Remove File" on target ...
```

### 检查清单

```
□ 脚本开头设 $ErrorActionPreference
□ try/catch 里给 -ErrorAction Stop
□ 外部程序用 $LASTEXITCODE 判断
□ 输出对象而不是 Write-Host
□ 危险操作先用 -WhatIf
□ 计划任务用 SYSTEM 账户
□ 文件保存为 UTF8BOM
```
