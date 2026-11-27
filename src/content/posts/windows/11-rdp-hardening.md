---
title: 远程访问与 RDP 加固：Windows 不会被爆破的那一半
description: RDP 暴露在公网的真实风险、四种安全接入方式、组策略加固项、以及"登录后被挤下线"这类现象的解释。
date: 2024-07-03
tags: [Windows, RDP, 远程访问, 安全]
---

### 公网 RDP 的风险有多真实

```
一个开放 3389 的机器，平均在几小时内就会开始被爆破
被攻破的常见路径：弱口令 → 登录 → 关闭杀毒 → 装远控/挖矿
```

**3389 暴露公网是勒索软件最常见的入口之一**。

### 四种安全接入方式

| 方式 | 安全性 | 复杂度 | 适用 |
| --- | --- | --- | --- |
| RDP over VPN | 高 | 中 | 常规运维 |
| RDP Gateway | 高 | 中 | 多用户、需审计 |
| SSH 隧道（跳板 Linux） | 高 | 低 | 已有 Linux 跳板 |
| 云厂商的"跳板机/堡垒机" | 高 | 低 | 云上环境 |
| 直接暴露 3389 | **极低** | 无 | 不要用 |

**SSH 隧道示例**（用一台 Linux 跳板机）：

```bash
ssh -L 13389:10.0.0.30:3389 ops@jump.example.com
# 然后 mstsc 连 127.0.0.1:13389
```

### 加固清单（八项）

**① 限制来源 IP**

```powershell
# 防火墙只允许办公网段
New-NetFirewallRule -DisplayName "RDP-Office" -Direction Inbound `
  -Protocol TCP -LocalPort 3389 -RemoteAddress 203.0.113.0/24 -Action Allow
```

**② 改端口（降低噪音，不是安全手段）**

```powershell
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' `
  -Name PortNumber -Value 13389
# 同时放通防火墙与更新连接方式
```

改端口只减少扫描噪音，**不能替代访问控制**。

**③ 网络级认证（NLA）**

```powershell
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' `
  -Name UserAuthentication -Value 1
```

NLA 让连接在建立会话前先做认证，能挡掉一类漏洞利用。

**④ 组策略加固**

```
计算机配置 → 管理模板 → Windows 组件 → 远程桌面服务 → 远程桌面会话主机 → 安全
- 要求使用特定安全层：SSL/TLS
- 设置客户端连接加密级别：高
- 要求计算机使用网络级别身份验证
- 设置会话时间限制
```

**⑤ 账号锁定策略**

```
失败 5 次锁定 30 分钟（防爆破）
同时避免把"服务账号"锁死（服务账号不参与锁定）
```

**⑥ 禁用来宾与空密码**

```powershell
Disable-LocalUser -Name Guest
# 检查空密码
Get-LocalUser | Where PasswordRequired -eq $false
```

**⑦ MFA / 条件访问**

```
有 Azure AD / 域 + MFA 方案时，RDP 也应纳入条件访问
"从陌生国家登录 → 要求 MFA" 能挡掉大部分盗号
```

**⑧ 会话审计**

```
开启"登录审核"（4624/4625），并集中收集
记录"谁在什么时间从哪个 IP 登录了哪台机器"
```

### 免费但有效的做法：限制工作时间

```powershell
# 用"存储的用户名/密码"不如用登录时间限制
net user alice /times:M-F,8:00-19:00
```

夜间不允许登录，能显著降低"被发现后长期潜伏"的风险。

### "登录后被挤下线"是什么

```
Windows 专业版/Server 默认只允许 1–2 个并发 RDP 会话
（Server 需要装"远程桌面服务"角色并买 RID 才能多会话）
第二个人登录会把前一个人挤掉
```

判断：

```powershell
# 查看当前会话
query session
qwinsta
```

**不是被攻击**，是授权限制。

### 常见故障

| 现象 | 原因 |
| --- | --- |
| 连不上，超时 | 防火墙/安全组未放通；或改端口后未放通新端口 |
| 连上后黑屏 | 显卡/驱动问题；尝试 `mstsc /admin` |
| 提示"凭据不工作" | 账号锁定、密码过期、或来源 IP 不在允许范围 |
| 提示"由于安全设置错误，客户端无法连接" | 加密级别/安全层不匹配 |
| 频繁断线 | 网络抖动；`KeepAliveInterval` 未设 |
| 无法复制粘贴 | 剪贴板重定向被组策略关闭 |

**"由于安全设置错误"的处理**：

```
① 客户端与服务端的加密级别要匹配
② 老客户端连新服务器时要降级安全层（不推荐）
③ 更常见：中间有设备做了 TLS 拦截
```

### 服务端 vs 客户端

```
服务端（被连的机器）：加固、限制来源、审计
客户端（运维人员）：别在公共电脑保存凭据
```

**客户端侧的一条硬规矩**：`.rdp` 文件里不要存明文密码（`password 51:b:...` 是可解密的）。

### 一个可用的组合

```
办公网 → VPN → 跳板机 → 内网 RDP
        + 来源 IP 白名单
        + 账号锁定策略
        + 登录审计集中收集
```

这套组合的成本很低，能挡掉 95% 的自动化攻击。

### 检查清单

```
□ 3389 不对公网开放
□ 有白名单（办公网段/跳板机）
□ 开启 NLA
□ 组策略要求 TLS 安全层
□ 账号锁定策略（5 次/30 分钟）
□ Guest 禁用，无空密码账号
□ 有登录审计（4624/4625 集中收集）
□ 关键机器有登录时间限制
□ 运维人员不在公共电脑保存凭据
```
