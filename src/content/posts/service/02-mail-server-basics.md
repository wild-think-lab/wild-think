---
title: 自建邮件服务器为什么难：SPF、DKIM、DMARC 与 IP 信誉
description: 收邮件容易，发邮件能进收件箱才是难关。讲清邮件系统的组成、三条认证记录、25 端口限制与自建/托管的选择。
date: 2026-11-27
tags: [邮件, Postfix, SPF, DKIM, DMARC]
---

### 现实先说清楚

自建邮件服务器从来没有像 Web 服务器那样"装上就能用"。原因不在软件，在**信誉体系**：

- 家宽/云主机默认 25 端口被封锁（阿里云、腾讯云、AWS 都要申请解封）。
- 新 IP 没有发信信誉，发出去的邮件大概率进垃圾箱。
- 反垃圾系统会校验 SPF、DKIM、DMARC、PTR、HELO 域名一致性，少一条就扣分。

所以结论是：**收信可以自建，发信建议走第三方中继（SES、Mailgun、阿里云邮件推送）+ 自己的域名**。企业邮箱规模上百人时，直接买 Exchange Online / 腾讯企业邮更省事。

自建的价值在于：学习邮件协议、内网通知系统、需要完全控制数据。

### 邮件系统的四个组件

| 组件 | 作用 | 常见实现 |
| --- | --- | --- |
| MTA | 服务器之间投递（SMTP） | Postfix、Exim |
| MDA/LDA | 把邮件写入用户邮箱 | Dovecot LDA、Procmail |
| IMAP/POP3 | 客户端拉取邮件 | Dovecot |
| Webmail | 网页收发 | Roundcube、SOGo |

最小可用组合：**Postfix（收发）+ Dovecot（IMAP 与认证）+ MySQL（虚拟用户）**。

### 三条 DNS 记录，缺一不可

假设域 `example.com`，发信服务器 `mail.example.com`（A 记录指向 1.2.3.4）。

**SPF**：声明哪些 IP 有权以你的域名发信

```
example.com.  TXT  "v=spf1 mx a:mail.example.com -all"
```

`-all` 表示"其余一律拒绝"。宁严不宽，`~all` 等于给伪造留门。

**DKIM**：给邮件加签名，防止内容被改

```
default._domainkey.example.com.  TXT  "v=DKIM1; k=rsa; p=MIGfMA0GCSq..."
```

公钥来自 `opendkim-genkey -d example.com -s default`，私钥留在服务器上，`opendkim.conf` 里配 `Selector default`。

**DMARC**：告诉收件方"SPF/DKIM 都不通过时怎么办"，并收报告

```
_dmarc.example.com.  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; pct=100"
```

顺序建议：先 `p=none` 收两周报告，确认所有合法发信源都在 SPF 里，再升到 `quarantine`、`reject`。

**还有一条常被忘**：PTR（反向解析）。云厂商控制台里给 1.2.3.4 配 `mail.example.com`，并且 HELO 名与 PTR 一致，否则 Gmail 直接降权。

### Postfix 最小配置要点

```
myhostname = mail.example.com
mydomain = example.com
myorigin = $mydomain
inet_interfaces = all
mydestination = $myhostname, localhost.$mydomain, localhost
relay_domains =
smtpd_tls_cert_file = /etc/letsencrypt/live/mail.example.com/fullchain.pem
smtpd_tls_key_file  = /etc/letsencrypt/live/mail.example.com/privkey.pem
smtpd_use_tls = yes
smtpd_tls_security_level = may
```

虚拟用户走 MySQL 时用 `virtual_mailbox_domains`、`virtual_mailbox_maps`，别用系统用户——否则每加一个邮箱就要建一个系统账号。

### 25 端口与中继

云主机上先测：

```bash
nc -zv smtp.example.com 25
```

如果出站 25 被封，两种解法：

1. 提交工单解封（通常要求域名备案、有正规业务说明）。
2. 配 `relayhost = [smtp.provider.com]:587`，用第三方中继发信，本地只负责收。

中继配置示例：

```
relayhost = [smtp.mailprovider.com]:587
smtp_sasl_auth_enable = yes
smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd
smtp_sasl_security_options = noanonymous
smtp_tls_security_level = encrypt
```

改完 `postmap /etc/postfix/sasl_passwd`，权限设 `600`。

### 验证发信是否达标

```bash
# 检查记录
dig TXT example.com +short
dig TXT default._domainkey.example.com +short
dig TXT _dmarc.example.com +short
dig -x 1.2.3.4 +short

# 发一封测试信到一个 Gmail 邮箱，然后在 Gmail 里点"显示原始邮件"
# 看三行：spf=pass / dkim=pass / dmarc=pass
```

三条都 pass，仍然进垃圾箱，通常是**内容与 IP 信誉问题**：新 IP 需要预热（从每天几十封开始逐步放量），且不要群发同样内容。

### 别忘了这些运维细节

- 邮箱存储会一直涨，配额和归档策略必须提前定。
- 一定要做备份：邮件既是业务数据也是法律证据。
- 开 TLS 强制后，老客户端（Foxmail 旧版、打印机扫描到邮件）会连不上，提前通知。
- 日志保留：`/var/log/mail.log` 至少 30 天，排"某封信没收到"全靠它。

邮件系统是唯一一个"配置全对也可能失败"的服务。接受这个现实，把认证记录做齐、把 IP 信誉养起来，比反复折腾 Postfix 参数有效。
