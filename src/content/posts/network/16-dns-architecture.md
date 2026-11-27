---
title: DNS 架构：一个"简单协议"背后的十个设计点
description: 递归与权威的分工、TTL 的取舍、多线路解析、CNAME 的坑、以及排查"解析不对"的顺序。
date: 2026-11-27
tags: [网络, DNS, 架构]
---

### 两类角色，别混为一谈

```
递归 DNS（Recursive）：替客户端去"查到底"（如 8.8.8.8、运营商 DNS、内网 CoreDNS）
权威 DNS（Authoritative）：回答"这个域名的记录是什么"（如阿里云解析、自建 BIND）
```

**常见错误**："我们的 DNS 挂了" —— 先分清是递归挂了还是权威挂了。

```
客户端访问任何网站都慢 → 递归的问题
只有你们自己域名解析不了 → 权威的问题
```

### 十个设计点

**① TTL 定多少**

```
短 TTL（60s）：便于切换（故障/迁移时生效快）
长 TTL（1h+）：减少查询量、提升性能
```

**实践**：

```
平时 300–600s
计划迁移前 24 小时先降到 60s
迁移完成并稳定后再调回
```

**"迁移当天才降 TTL"是经典错误**：老的 TTL 还在缓存里，改解析要等它过期。

**② 多线路（智能解析）**

```
电信用户 → 电信 IP
联通用户 → 联通 IP
海外用户 → 海外节点
```

**实现**：

```
权威 DNS 根据"递归 DNS 的出口 IP"判断线路
→ 所以递归 DNS 的地理位置决定了准确性
```

**坑**：

```
用户和递归 DNS 不在同一地区（如用户在上海，用的是公司总部的 DNS）
→ 智能解析会判断错
```

**③ CNAME 链不要超过 2 跳**

```
www.example.com CNAME → cdn.example.com CNAME → edge.vendor.com
```

**代价**：

```
每跳一次 CNAME 就多一次查询（延迟叠加）
某些递归 DNS 会"压平"（flatten）CNAME，行为不一致
```

**④ Apex 域名不能用 CNAME（传统限制）**

```
example.com（根域）不能设 CNAME（会与 SOA/NS 冲突）
→ 用 ALIAS/ANAME（部分服务商支持）或直接 A 记录
```

**这是"为什么根域不能接 CDN"的常见原因**（现在很多 CDN 支持 CNAME Flattening）。

**⑤ 泛解析（wildcard）要谨慎**

```
*.example.com → 1.2.3.4
```

**风险**：

```
任何不存在的子域都会解析成功
→ 邮件服务器会被"catch-all"误收
→ 攻击者可以枚举（每个子域都"存在"）
```

**⑥ SPF / DKIM / DMARC 的 TXT 记录**

```
TXT @  "v=spf1 include:_spf.example.com -all"
TXT _dmarc  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"
TXT selector._domainkey  "v=DKIM1; k=rsa; p=MIIB..."
```

**注意**：

```
① SPF 里的 include 有跳数上限（10 次）
② TXT 记录过长会被拆成多段（工具会自动拼）
③ 一条记录里不要塞多条策略（分开放）
```

**⑦ 内网 DNS 与外网 DNS 分开**

```
内网：CoreDNS / Windows DNS（解析内部域名 + 转发外部）
外网：权威 DNS（只回答公网域名）
```

**"内网也用公网权威"的问题**：

```
① 内部域名不能暴露
② 内网查公网要走外网，可能受阻
```

**⑧ 递归 DNS 的缓存与污染**

```
递归 DNS 缓存决定了"改了多久生效"
→ 改解析后要等 TTL + 递归的缓存时间
```

**验证是否生效**：

```bash
dig @8.8.8.8 example.com +short        # 看公共 DNS
dig @<你的权威> example.com +short      # 看权威本身
dig +trace example.com                  # 看完整链路
```

**⑨ DNSSEC（可选但越来越重要）**

```
给 DNS 记录做密码学签名，防篡改
→ 但配置复杂，且配错了会导致整个域名不可解析
```

**建议**：重要域名可以上，但要有"回滚方案"（先观察再启用）。

**⑩ 监控与告警**

```
① 关键域名的解析是否正常（从多个地域探）
② 权威 DNS 的响应时间
③ 记录是否被意外修改（对比基线）
④ 域名/证书的到期时间
```

**"域名忘了续费"是最低成本、最高影响的故障**。

### 排查"解析不对"的顺序

```bash
# 1. 权威返回什么（绕过缓存）
dig @ns1.example.com example.com +short

# 2. 公共递归返回什么
dig @8.8.8.8 example.com +short

# 3. 本机用的是什么 DNS
cat /etc/resolv.conf

# 4. 完整链路（看在哪一级断了）
dig +trace example.com

# 5. 具体记录类型
dig example.com MX
dig _dmarc.example.com TXT
dig example.com AAAA
```

**四种典型结论**：

```
① 权威不对 → 改解析记录
② 权威对、递归不对 → 缓存未过期（等 TTL）
③ 递归对、本机不对 → 本机 DNS 配置/缓存（systemd-resolved / nscd）
④ 都对、应用不对 → 应用自己的 DNS 缓存（如 JVM）
```

**JVM 的坑**：

```
默认 networkaddress.cache.ttl = -1（永不失效，除非重启）
→ 改了 DNS 但 Java 应用不生效
```

修法：

```java
// 或 -Dsun.net.inetaddr.ttl=60
java.security.Security.setProperty("networkaddress.cache.ttl", "60");
```

### 一个"改了解析但不生效"的完整排查

```
现象：把 www 的 A 记录从 1.1.1.1 改成 2.2.2.2
      自己电脑 curl 还是打到 1.1.1.1

① dig @权威 www → 2.2.2.2 ✓（权威已生效）
② dig @8.8.8.8 www → 1.1.1.1 ✗（递归还有缓存）
③ 等 TTL（原 TTL 是 3600s → 最多 1 小时）
④ 清本机缓存：sudo systemd-resolve --flush-caches
⑤ 应用侧：重启或调小 JVM 缓存
```

**"下次迁移前先降 TTL"就是从这里来的教训**。

### 检查清单

```
□ 区分递归与权威（排查先分清）
□ 关键域名 TTL 平时 300–600s
□ 迁移前 24 小时降 TTL 到 60s
□ CNAME 不超过 2 跳
□ 根域用 A/ALIAS（不用 CNAME）
□ 泛解析慎用（防枚举/误收邮件）
□ SPF/DKIM/DMARC 配好且 DMARC p≥quarantine
□ 内外网 DNS 分开
□ 有解析监控（多地探 + 基线对比）
□ 域名与证书到期提醒
□ 应用侧 DNS 缓存有设置（JVM 尤其）
```
