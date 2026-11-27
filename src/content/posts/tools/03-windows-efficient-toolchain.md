---
title: Windows 侧的效率工具箱：包管理、终端与脚本
description: 别再用"下载安装包 → 下一步 → 下一步"。winget/scoop 管软件、Windows Terminal + PowerShell 7 管终端、计划任务与 profile 管自动化。
date: 2026-11-27
tags: [Windows, 工具, winget, PowerShell, 效率]
---

### 三件事把 Windows 变成能干活的环境

1. **包管理**：软件装、更新、卸载都能一条命令。
2. **终端**：一个能分屏、能记历史、能配主题的窗口。
3. **脚本**：重复操作写成 PowerShell 函数，随 profile 加载。

### winget：官方包管理

```powershell
winget search nginx
winget install --id Git.Git -e
winget install --id Microsoft.PowerShell -e
winget upgrade --all
winget list --upgrade-available
```

优点：微软官方源 + 大量厂商提交，和 App Installer 集成。缺点：部分软件仍需交互式安装、企业环境可能需要代理。

常用清单：

```powershell
# 导出/恢复（换机器时非常省事）
winget export -o D:\setup\winget.json
winget import -i D:\setup\winget.json
```

### scoop：绿色软件与开发工具

```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
irm get.scoop.sh | iex

scoop bucket add extras
scoop install git 7zip ripgrep fd fzf neovim
scoop update *
```

优点：装到用户目录，不需要管理员权限，卸载干净（直接删目录）。适合 CLI 工具、便携软件。

分工建议：**系统级软件用 winget，CLI 与便携工具用 scoop。**

### Windows Terminal + PowerShell 7

```powershell
# 默认 shell 改为 pwsh 7
# Terminal 设置 → 默认配置文件 → PowerShell 7
```

必备配置（`$PROFILE`，路径 `~\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`）：

```powershell
# 主题与提示符（需先 Install-Module posh-git / oh-my-posh）
Import-Module posh-git
oh-my-posh init pwsh --config "$env:POSH_THEMES_PATH\jandedobbeleer.omp.json" | Invoke-Expression

# 常用别名
Set-Alias ll Get-ChildItem
function grep { param($p) Select-String -Pattern $p -Path * -Recurse }
function ports { Get-NetTCPConnection -State Listen | Sort-Object LocalPort }

# 默认 UTF-8，避免中文乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
```

`ports` 这个函数比 `netstat -ano` 好用：直接给你端口、进程名、PID。

### 系统排查常用命令（替代图形界面）

```powershell
# 进程与端口
Get-Process | Sort CPU -Descending | Select -First 10 Name, CPU, WS
Get-NetTCPConnection -State Listen | Select LocalAddress, LocalPort, OwningProcess

# 磁盘
Get-Volume | Select DriveLetter, SizeRemaining, Size
Get-ChildItem C:\ -Directory | ForEach-Object {
  [pscustomobject]@{ Dir=$_.FullName; GB=[math]::Round((Get-ChildItem $_.FullName -Recurse -Force -EA 0 |
    Measure-Object Length -Sum).Sum/1GB,2) }
} | Sort GB -Descending | Select -First 10

# 事件日志（最近 1 小时错误）
Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2; StartTime=(Get-Date).AddHours(-1)} |
  Select TimeCreated, Id, ProviderName, Message -First 10

# 服务
Get-Service | Where Status -eq 'Stopped' | Select Name, DisplayName
```

### 计划任务（替代"手动点一下"）

```powershell
$action  = New-ScheduledTaskAction -Execute 'pwsh.exe' `
  -Argument '-NoProfile -File D:\scripts\backup.ps1'
$trigger = New-ScheduledTaskTrigger -Daily -At 03:00
$set     = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'DailyBackup' -Action $action `
  -Trigger $trigger -Settings $set -User 'SYSTEM' -RunLevel Highest
```

三个参数值得记住：`-StartWhenAvailable`（错过时间开机补跑）、`MultipleInstances IgnoreNew`（防重入）、`RunLevel Highest`（需要管理员权限时）。

### 效率小工具清单

| 工具 | 作用 |
| --- | --- |
| fzf | 模糊查找文件/历史命令 |
| ripgrep (rg) | 比 findstr 快一个数量级的文本搜索 |
| fd | 更友好的 find |
| bat | 带高亮的 cat |
| 7-Zip | 解压（装 scoop 后命令行 `7z` 可用） |
| Sysinternals Suite | Process Explorer / TCPView / Autoruns，排查神器 |

```powershell
scoop install fzf ripgrep fd bat
# rg 用法
rg -n "timeout" D:\project\src
```

### 一个实际脚本：批量检查机器补丁与磁盘

```powershell
param([string[]]$Computers = @($env:COMPUTERNAME))
$out = foreach ($c in $Computers) {
  try {
    Invoke-Command -ComputerName $c -ScriptBlock {
      [pscustomobject]@{
        Host    = $env:COMPUTERNAME
        LastHotfix = (Get-HotFix | Sort InstalledOn -Descending |
                      Select -First 1).HotFixID
        FreeGB  = [math]::Round((Get-Volume C:).SizeRemaining/1GB,1)
        Uptime  = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
      }
    } -ErrorAction Stop
  } catch {
    [pscustomobject]@{ Host=$c; Error=$_.Exception.Message }
  }
}
$out | Format-Table -AutoSize
```

### 几条习惯建议

- 所有脚本放固定目录（如 `D:\scripts`），加入 PATH。
- 用 Git 管理你的 PowerShell 脚本与 profile，换机器直接 clone。
- 别用记事本改配置文件，用 VS Code（`winget install Microsoft.VisualStudioCode`）。
- 管理员操作默认用 `sudo`（Windows 11 已原生支持）或明确开提权窗口，别整天挂管理员。

工具的价值不在多，而在**你每次都要做的事，只需敲一条命令**。
