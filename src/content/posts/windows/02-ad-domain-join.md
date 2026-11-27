---
title: 搭一个 AD 域：从装角色到把电脑加进来
description: 域控不是"装个角色就完事"，DNS 指向、SRV 记录、加入域失败的五种原因，全在这一篇。
date: 2022-03-24
tags: [Windows, AD域, DNS, 域控, 实验]
---

### 域到底解决了什么

没有域，每台电脑自己管自己的账号：10 台机器 10 套密码，改一个人要动 10 次。有域之后：

- **一处改，全网生效**：账号、密码、权限、策略都在域控上。
- **统一身份**：登录任意加入域的电脑，桌面、权限、映射盘都一样。
- **策略下发**：组策略统一控制 U 盘、屏保、防火墙、软件安装。

一句话：域是"集中身份与策略"，不是"多一台服务器"。

### 装 AD DS 角色

在准备做域控的机器上（Administrator 打开 PowerShell）：

```powershell
Install-WindowsFeature AD-Domain-Services -IncludeManagementTools
Install-WindowsFeature DNS -IncludeManagementTools
```

然后用向导提升为域控（新建林）：

```powershell
Import-Module ADDSDeployment
Install-ADDSForest `
  -DomainName "corp.lab" `
  -DomainNetbiosName "CORP" `
  -InstallDns:$true `
  -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!Lab" -AsPlainText -Force) `
  -Force
```

执行完会自动重启。**域控的 DNS 必须指向自己**（`127.0.0.1` 或本机固定 IP），指向外部 DNS 会导致客户端找不到域。

### 验证域控真的活了

```powershell
Get-ADDomain
Get-Service NTDS, DNS, KDC, Netlogon
nslookup -type=SRV _ldap._tcp.dc._msdcs.corp.lab
```

第三条是关键：客户端找域控靠 **SRV 记录**，查不到 SRV 就一定加入域失败。很多"域控装好了但加不进去"的根因就在这。

### 把一台电脑加入域

客户端侧（DNS 先改成域控 IP）：

```powershell
# 图形方式：sysdm.cpl → 更改 → 域，输入 corp.lab
# 命令行方式（需要重启）
Add-Computer -DomainName "corp.lab" -Credential (Get-Credential) -Restart
```

加入成功后，登录界面会出现 `CORP\用户名`。

### 加入域失败的六种原因

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `找不到网络路径` | DNS 指向错，或网络不通 | 客户端 `nslookup corp.lab` 必须返回域控 IP |
| `指定的域不存在` | 域名拼错、SRV 缺失 | 域控上查 SRV 记录 |
| `登录失败：用户名或密码错误` | 用的是本地账号，不是域账号 | 输入 `CORP\user` |
| `信任关系失败` | 机器账号在 AD 里重复/残留 | AD 用户和计算机里删旧计算机对象再加 |
| `时间偏差过大` | 客户端与域控时间差 >5 分钟 | `w32tm /resync` |
| `RPC 服务器不可用` | 防火墙挡住 135/445/动态端口 | 放行域网络配置文件 |

排这六条，比反复重装域控有效得多。

### 常用域账号操作

```powershell
New-ADUser -Name "zhangsan" -SamAccountName "zhangsan" `
  -UserPrincipalName "zhangsan@corp.lab" `
  -Path "OU=Users,DC=corp,DC=lab" `
  -AccountPassword (ConvertTo-SecureString "Init@12345" -AsPlainText -Force) `
  -Enabled $true

Get-ADUser -Filter * | Select-Object Name, Enabled
Add-ADGroupMember -Identity "Domain Admins" -Members "zhangsan"
```

**OU 不是装饰**：组策略、权限、委派都挂在 OU 上。建之前先想清楚组织架构（部门还是站点），后面改起来很麻烦。

### 本章要点

- 域的核心价值是集中身份与策略，不是多一台机器。
- 域控 = AD DS + DNS，DNS 必须指向自己。
- 客户端找不到域控，先查 SRV 记录。
- OU 结构决定后面所有策略与委派的难度。
