---
title: 邮件认证三件套：SPF、DKIM、DMARC 实战
description: 自建邮件服务器为什么总是进垃圾箱。三个 DNS 记录各自管什么、怎么配、怎么验证，以及转发场景的已知硬伤。
date: 2026-11-24
tags: [邮件, 域名, 安全基线]
---

自建 SMTP 之后最常撞的墙不是"发不出去"，而是"发出去了进垃圾箱"或"对方直接 550 拒绝"。原因几乎都在三个 DNS 记录上：SPF、DKIM、DMARC。

## 各自管什么

```
SPF：哪些 IP 有权用这个域名发信（信封发件人）
DKIM：这封邮件是否被篡改、是否真由该域名签发（密码学签名）
DMARC：上面两项不通过时怎么办，以及把报告发给谁（策略）
```

**关键**：三者不是替代关系。只配 SPF 会在转发时失效；只配 DKIM 不配 DMARC 就没有策略约束。

## SPF

```dns
example.com.  TXT  "v=spf1 ip4:203.0.113.10 include:_spf.provider.com -all"
```

要点：

```
① 一个域名只能有一条 SPF 记录（多条会直接判定 permerror）
② 查 10 次 DNS 是硬上限（include 过多会超限）
③ -all 表示"不在列表的一律失败"，~all 是软失败（更宽松）
```

验证：

```bash
dig +short TXT example.com
# 或
swaks --to test@example.com --from sender@example.com --server 127.0.0.1
```

**坑**：邮件列表/自动转发会改变发信 IP，SPF 必然失败（信封发件人还是你）。这是协议层面的硬伤，只能靠 DKIM 兜。

## DKIM

```bash
# OpenDKIM 生成密钥（2048 位更稳）
opendkim-genkey -b 2048 -d example.com -s mail
```

生成的公钥要放到 DNS：

```dns
mail._domainkey.example.com.  TXT  "v=DKIM1; k=rsa; p=MIIBIjANBg..."
```

配置要点：

```
① selector（这里 mail）要与 DNS 记录名一致
② 私钥权限 600，属主是邮件服务用户
③ canonicalization 建议 relaxed/relaxed（转发/改头时更稳）
④ 签名域 d= 应与 From 域对齐（DMARC 靠这个）
```

验证：

```bash
opendkim-testkey -d example.com -s mail -vvv
# 收件端看头
Authentication-Results: ... dkim=pass header.d=example.com
```

## DMARC

```dns
_dmarc.example.com.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com; ruf=mailto:dmarc@example.com; pct=100; adkim=r; aspf=r"
```

策略演进（必须循序渐进）：

```
p=none        先观察 2-4 周，收报告看谁在替你发信
p=quarantine  不合格进垃圾箱
p=reject      直接拒绝（最终目标）
```

**判据**：`rua` 报告里出现不明来源 IP，先查清是谁在用你的域名发信，再收紧策略——直接上 reject 会把正常业务邮件打掉。

对齐（alignment）：

```
adkim=r 宽松：子域也算通过（mail.example.com 与 example.com 视为对齐）
adkim=s 严格：必须完全一致
```

## 三个必备配套

```
① PTR（反向解析）：IP 反解到发信域名，很多收件方会查
② HELO 名：与 PTR 一致，别用 localhost
③ TLS：25 端口支持 STARTTLS（现在多数要求）
```

## 常见报错与判据

| 现象 | 判据 | 处置 |
| --- | --- | --- |
| `550 5.7.1 unauthenticated` | 收件方要求 SPF/DKIM 至少一项通过 | 补 DKIM，确认签名域对齐 |
| `550 5.7.26` | SPF 查了但失败（常见转发） | 用 DKIM 兜底，检查 `-all` |
| 进垃圾箱但无报错 | DMARC 未通过、PTR 缺失、内容触发规则 | 看 `Authentication-Results` 头 |
| 部分收件人收不到 | 你的 IP 在 RBL 黑名单 | 查 Spamhaus，申诉并修配置 |
| 大附件被退 | 对方限制大小 | 用链接而非附件 |

## 五个"配了还是失败"

**① 两条 SPF 记录**（历史遗留 + 新加），直接 permerror

**② include 太多超过 10 次查询**，判定超限

**③ DKIM 公钥换行被截断**，DNS TXT 要用引号拼接成多段

**④ selector 写错**（DNS 是 `mail._domainkey`，配置里是 `default`）

**⑤ 用根域发信但签名域是子域**，严格对齐下 DMARC 失败

## 一个可复现的检查脚本

```bash
DOMAIN=example.com
dig +short TXT $DOMAIN | grep spf
dig +short TXT mail._domainkey.$DOMAIN
dig +short TXT _dmarc.$DOMAIN
dig +short -x $(dig +short A mail.$DOMAIN)
```

四条都有输出、且互相一致，才算"三件套齐了"。

## 检查清单

```
□ 只有一条 SPF，且 include 不超 10 次
□ DKIM 2048 位、relaxed/relaxed、选择器一致
□ DMARC 先 none 观察，再逐步收紧
□ rua 报告有接收并在看
□ PTR 与 HELO 一致
□ 25 端口支持 STARTTLS
□ 有黑名单监控
□ 转发场景有预期（SPF 会失败，靠 DKIM）
□ 有定期验证脚本
□ 发信 IP 固定（不做动态 IP 发信）
```
