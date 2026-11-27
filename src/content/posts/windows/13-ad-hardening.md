---
title: AD 域加固：十个最容易被审计开单的地方
description: 从 kerberoasting 到 SMB 签名，十个具体的域内风险点、检测命令与加固动作。
date: 2026-11-27
tags: [Windows, AD, 安全, 加固]
---

### 域环境的安全特点

```
一次拿到域管权限 → 整个域沦陷
所以攻击者的目标往往不是"某台机器"，是"域管账号"
```

**下面十个点是域渗透最常走的路，也是审计最爱开的单**。

### ① 特权组人员过多

```powershell
# 看这些组里都有谁
Get-ADGroupMember "Domain Admins" | Select Name,ObjectClass
Get-ADGroupMember "Enterprise Admins"
Get-ADGroupMember "Schema Admins"
Get-ADGroupMember "Account Operators"
```

**加固**：

```
Domain Admins 应 < 5 人
日常运维不用域管（用委派 + 最小权限）
Schema Admins 平时应空（需要时才临时加）
```

**"日常用域管登录"是最大的风险**：域管账号一登录普通工作站，凭据就可能被窃取。

### ② 域管账号登录了普通机器

```powershell
# 查域管账号在哪些机器上有登录记录
# 需要开"审核登录"或用工具（如 BloodHound 的登录记录）
```

**加固**：

```
① 域管只从"特权访问工作站（PAW）"登录
② 域管账号禁止登录普通工作站（GPO：Deny log on locally / Deny log on through Remote Desktop）
③ 用 Protected Users 组（禁止 NTLM、禁止凭据缓存、短票据）
```

**`Protected Users` 组**是很有效的一招：

```powershell
Add-ADGroupMember -Identity "Protected Users" -Members "da-user1"
```

### ③ Kerberoasting（最容易得手）

**原理**：任何域用户都能请求"带 SPN 的服务票据"，票据用服务账号的密码 hash 加密 → 离线爆破。

```powershell
# 找有 SPN 的账号（这些都可被攻击）
Get-ADUser -Filter { ServicePrincipalName -ne "$null" } `
  -Properties ServicePrincipalName,PasswordLastSet |
  Select Name,ServicePrincipalName,PasswordLastSet
```

**加固**：

```
① 清理不必要的 SPN
② 服务账号不用"用户账号"（改用 gMSA 托管账号）
③ 强密码 + 定期轮换
④ 监控"大量请求服务票据"的行为（事件 4769）
```

**事件 4769 的监控规则**：短时间内同一账号请求大量不同 SPN 的票据 = 可疑。

### ④ 密码策略太弱

```powershell
Get-ADDefaultDomainPasswordPolicy
# MinPasswordLength / LockoutThreshold / LockoutDuration
```

**建议值**：

```
最小长度 ≥ 12（不是 8）
锁定阈值 ≤ 5 次
锁定时长 ≥ 30 分钟
必须启用"密码历史"（禁止重用）
```

**"复杂度要求"其实价值有限**：`P@ssw0rd` 满足复杂度但一秒被破。长度更重要。

### ⑤ 未限制 NTLM

```
NTLM 不防中间人，且可被 relay 攻击（NTLM Relay）
```

**加固（分阶段）**：

```
① 先开"审核 NTLM"（看谁还在用）
② 再做"限制 NTLM 出站"（只允许白名单）
③ 最后才"禁止 NTLM"（需确认没有老系统依赖）
```

**别一上来就全禁**：老打印机、老 NAS 可能只支持 NTLM。

### ⑥ SMB 签名未强制

```powershell
Get-SmbServerConfiguration | Select RequireSecuritySignature
```

**风险**：SMB Relay（把认证中继到另一台机器）。

**加固**：

```powershell
Set-SmbServerConfiguration -RequireSecuritySignature $true -Force
Set-SmbClientConfiguration -RequireSecuritySignature $true -Force
```

**注意**：老设备（老 NAS、某些打印机）可能不支持签名 → 先盘点。

### ⑦ LLMNR / NBT-NS 未关闭

```
这两个协议用于"局域网名字解析"，可被投毒 → 中间人
```

**加固（GPO）**：

```
计算机配置 → 管理模板 → 网络 → DNS 客户端 → 关闭多播名称解析 → 已启用
```

再通过注册表禁用 NBT-NS：

```
HKLM\SYSTEM\CurrentControlSet\Services\NetBT\Parameters\Interfaces\*
  NetbiosOptions = 2
```

### ⑧ 委派配置过宽

```powershell
# 无约束委派（最危险）
Get-ADUser -Filter { TrustedForDelegation -eq $true } -Properties TrustedForDelegation
Get-ADComputer -Filter { TrustedForDelegation -eq $true }
```

**加固**：

```
无约束委派 → 改为"约束委派"或"资源约束委派"
只允许委派到必要的服务（不是"任意服务"）
```

**无约束委派等于"拿到该系统权限就能冒充任何用户访问任何服务"**。

### ⑨ 域内 ACL 过宽（最隐蔽）

```
GenericAll / WriteDACL / WriteOwner 给到了不该给的用户/组
→ 可以给自己加权限，最终拿到域管
```

**加固**：

```
① 定期用 ADACLScanner 出报告
② 只给"必要的权限"（如 Helpdesk 只给重置密码）
③ 特别注意 OU 上的 ACL（能改 OU 就可能能改里面的对象）
```

### ⑩ 老协议与老系统

```
① SMBv1（勒索病毒的最爱）
② NTLMv1
③ 匿名 LDAP 绑定
④ 未签名的 LDAP
```

```powershell
Get-SmbServerConfiguration | Select EnableSMB1Protocol
Set-SmbServerConfiguration -EnableSMB1Protocol $false -Force
```

**LDAP 签名**：

```
域控上：LdapEnforceChannelBinding = 2（要求签名）
```

### 监控要看的事件

| 事件 ID | 含义 | 关注点 |
| --- | --- | --- |
| 4624 | 登录成功 | 类型 3（网络）、10（RDP）异常 |
| 4625 | 登录失败 | 短时间大量 = 爆破 |
| 4672 | 分配特殊特权 | 域管登录 |
| 4768/4769 | 请求 TGT/服务票据 | Kerberoasting 迹象 |
| 4720/4728 | 创建用户/加组 | 权限提升 |
| 5136 | 目录对象修改 | ACL 变更 |

**"4672 在普通工作站上出现"是极强的信号**：说明域管在那台机器上登录了。

### 加固的推进顺序

```
第 1 步（低风险高收益）
- 关 SMBv1、关 LLMNR
- 清理特权组成员
- 强密码策略

第 2 步（需盘点）
- 限制 NTLM（先审核）
- 强制 SMB 签名
- 清理 SPN 与委派

第 3 步（需流程配套）
- 域管 PAW + Protected Users
- ACL 收敛
```

### 检查清单

```
□ Domain Admins / Enterprise Admins 人数 < 5
□ 域管账号禁止登录普通工作站
□ 关键账号在 Protected Users 组
□ 有 SPN 的账号盘点过，服务账号用 gMSA
□ 密码长度 ≥ 12、锁定 ≤ 5 次
□ 审核 NTLM 并有收敛计划
□ SMB 签名已强制
□ LLMNR / NBT-NS 已关
□ 无约束委派已清理
□ ACL 用工具审过
□ SMBv1 已关、LDAP 要求签名
□ 监控 4672 / 4769 / 4720 / 5136
```
