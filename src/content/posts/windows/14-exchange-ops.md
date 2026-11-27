---
title: Exchange 运维：邮件不通的七个断点与三条常用命令
description: 从 DNS 到队列、从证书到反垃圾，把"发不出/收不到"拆成可检查的七段。
date: 2025-02-24
tags: [Windows, Exchange, 邮件]
---

### 邮件流动的七段

```
① 发件方 MUA → 提交到发件服务器（SMTP 587/465）
② 发件服务器反垃圾/防伪造检查（SPF 有时也看）
③ 发件服务器 → 收件域名的 MX（SMTP 25）
④ 收件服务器反垃圾/灰名单/SPF-DKIM-DMARC 检查
⑤ 收件服务器投递到邮箱存储
⑥ 用户 MUA 通过 MAPI/IMAP/POP 或 OWA 拉取
⑦ 客户端展示
```

**"邮件不通"必须定位在哪一段**，否则会瞎改。

### 七个断点与检查

**① 发件端提交失败（客户端报错）**

```
检查：587/465 是否开放、是否要求认证、证书是否有效
日志：Client Submission 日志（%ExchangeInstallPath%TransportRoles\Logs\FrontEnd\ProtocolLog\SmtpSend）
```

**② 发件服务器的出站连接被拒**

```powershell
# 测试到对方 MX 的连通
Test-NetConnection -ComputerName mx.example.com -Port 25

# 查看队列
Get-Queue | Format-Table Identity, Status, MessageCount, NextHopDomain
```

**`Get-Queue` 是最常用的命令**：队列积压说明"出不去"。

**③ MX 解析错误 / 多 MX 优先级问题**

```powershell
nslookup -type=mx example.com
Resolve-DnsName example.com -Type MX
```

**检查**：

```
① MX 指向的地址是否正确（尤其换服务商后）
② 有没有残留的旧 MX（导致半数邮件走旧服务器）
③ MX 记录的优先级（数字小的优先）
```

**④ 反垃圾把邮件拒了**

```
现象：发件方收到 550 5.7.x
常见原因：
① SPF 不通过（发送 IP 不在 SPF 记录里）
② DKIM 签名缺失/验证失败
③ DMARC 要求对齐（From 域与 SPF/DKIM 域不一致）
④ IP 声誉差（进过黑名单）
```

**查 SPF/DKIM/DMARC**：

```bash
# 用工具或手工查
dig TXT example.com | grep spf
dig TXT _dmarc.example.com
dig TXT selector._domainkey.example.com
```

**自测工具**：mail-tester.com（免费，给出完整检查清单）。

**⑤ 收件服务器投递失败**

```powershell
# 查看传输队列与投递状态
Get-TransportService | Get-Queue
Get-MessageTrackingLog -Start (Get-Date).AddHours(-1) -ResultSize Unlimited |
  Where-Object {$_.EventId -in "FAIL","DROP"} | Format-Table Timestamp,Sender,Recipients,EventId
```

**`Get-MessageTrackingLog` 是 Exchange 的"全链路追踪"**：

```
一次邮件在 Exchange 内部的每一次处理都有记录
→ 定位到"卡在哪一步"非常准
```

**⑥ 邮箱存储问题（收件人侧）**

```
现象：邮件到了服务器但用户收不到
检查：
① 邮箱是否禁用/配额满
② 是否被规则/垃圾邮件隔离
③ 客户端连接是否正常（MAPI/OWA）
```

**⑦ 客户端问题**

```
能 OWA 看到但客户端收不到 → 客户端缓存/配置
OWA 也看不到 → 服务器侧问题
```

**"先开 OWA 对比"是最快的分流手段**。

### 三条最常用命令

```powershell
# 1. 追踪一封邮件
Get-MessageTrackingLog -Sender a@corp.com -Recipients b@corp.com `
  -Start (Get-Date).AddDays(-1) -ResultSize Unlimited |
  Select Timestamp, EventId, Source, MessageSubject | Format-Table -AutoSize

# 2. 看队列
Get-Queue | FT Identity, DeliveryType, Status, MessageCount, NextHopDomain

# 3. 看邮件流连接器
Get-SendConnector | FT Name, AddressSpaces, Enabled
Get-ReceiveConnector | FT Name, Bindings, Enabled, RemoteIPRanges
```

**"连接器配置"是 Exchange 最容易配错的地方**（尤其是多站点与混合部署）。

### 常见故障对照表

| 现象 | 最可能原因 | 命令/检查 |
| --- | --- | --- |
| 外发邮件全部卡在队列 | 出站连接器/防火墙 25 端口 | `Get-Queue` + `Test-NetConnection` |
| 只有发给某域失败 | 对方反垃圾拒收 | 看 NDR 的 5.7.x 代码 |
| 内部邮件正常、外部不通 | 连接器或 MX 问题 | `Get-SendConnector` |
| 大量邮件进垃圾箱 | SPF/DKIM/DMARC | mail-tester |
| 收到大量"退信" | 被用作中继（开放中继） | `Get-ReceiveConnector` 的权限 |
| OWA 正常客户端异常 | 客户端缓存/自动配置 | Outlook 测试连接 |

**"被用作开放中继"是严重安全事件**：

```
检查：匿名中继是否被允许
Get-ReceiveConnector | FL Name, PermissionGroups
```

**只应允许"Exchange 服务器"组与"ExchangeLegacyInterop"**，不能有 "Anonymous"。

### 数据库与日志

```powershell
# 邮箱数据库状态
Get-MailboxDatabase -Status | FT Name, Mounted, DatabaseSize, AvailableNewMailboxSpace

# 副本状态（DAG）
Get-MailboxDatabaseCopyStatus * | FT Name, Status, ContentIndexState, CopyQueueLength

# 日志文件清理（会吃满磁盘）
Get-ChildItem "$env:ExchangeInstallPath\TransportRoles\Logs" -Recurse |
  Where-Object {$_.LastWriteTime -lt (Get-Date).AddDays(-7)} | Remove-Item -Force
```

**Transport 日志吃满系统盘是 Exchange 的经典事故**：

```
建议：日志目录与数据库分盘，且定期清理（保留 7 天）
```

### 证书（非常常见）

```powershell
# 查看证书
Get-ExchangeCertificate | FT Thumbprint, Subject, Services, NotAfter

# 给服务分配证书
Enable-ExchangeCertificate -Thumbprint <thumbprint> -Services SMTP,IIS
```

**证书要点**：

```
① SMTP 需要证书（用于 TLS）
② IIS 需要证书（OWA/ECP）
③ 多域名用 SAN 证书
④ 到期前 30 天必须续（否则全站 TLS 失败）
```

**"证书过期导致全公司邮件客户端报错"是最常见的年度事故**。

### 反垃圾配置基线

```powershell
# 查看反垃圾相关
Get-ContentFilterConfig
Get-SenderReputationConfig
Get-IPBlockListProvider

# SPF/DKIM/DMARC 由 DNS 与传输代理负责
Get-TransportAgent
```

**建议**：

```
① 开启 SPF 校验（不通过则拒绝或标记）
② 配置 DKIM 签名（能显著提升送达率）
③ DMARC 先 p=none 观察，再 p=quarantine
④ IP 声誉维护（不要用共享 IP 发信）
```

### 检查清单

```
□ 定位到七段中的哪一段（不瞎改）
□ Get-Queue 看积压
□ Get-MessageTrackingLog 全链路追踪
□ Test-NetConnection 测 25 端口
□ MX 解析正确且无残留
□ SPF/DKIM/DMARC 用工具实测
□ 连接器权限正确（禁止匿名中继）
□ Transport 日志定期清理
□ 证书到期监控（30 天预警）
□ DAG 副本与内容索引状态监控
□ OWA 与客户端双路验证
```
