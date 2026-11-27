---
title: 部署内网基础服务：DNS / DHCP / NTP
module: 熟练篇
summary: 自建 DNS（dnsmasq/BIND）、DHCP 保留地址、NTP 时间同步,以及五个"内网服务互相打架"的原因。
minutes: 45
---

## 一、先弄懂它们是什么

三个"地基服务"，缺一个内网就会莫名其妙地不好用：

```
DNS：把名字翻译成 IP（应用的地址解耦）
DHCP：把 IP 自动发给设备（含网关/DNS 下发）
NTP：让所有机器的时钟一致（证书、日志、分布式锁都依赖它）
```

### DNS 的两种角色（分清才配得对）

```
递归解析器（resolver）：替客户端一层层问，最后给答案（dnsmasq 常兼这个）
权威服务器（authoritative）：它就是某个域名的"官方答案"（BIND 做这个）
```

**判据**：内网域名解析失败，先分清是"权威没记录"还是"递归没转发"。

### 记录类型（必须认识）

| 类型 | 含义 | 例 |
| --- | --- | --- |
| A / AAAA | 域名 → IPv4 / IPv6 | `app → 10.0.0.20` |
| CNAME | 别名 → 另一个域名 | `www → app` |
| MX | 邮件服务器 | `@ → mail` |
| TXT | 文本（SPF/DKIM/验证） | `v=spf1 ...` |
| PTR | 反向解析 IP → 域名 | 邮件必备 |
| SRV | 服务+端口发现 | `_ldap._tcp` |

### DHCP 的四步（DORA）

```
Discover（客户端广播找）→ Offer（服务器给）→ Request（客户端要）→ Ack（确认）
```

```
① 两套 DHCP 同时存在 → 地址冲突
② 地址池与静态 IP 重叠 → 冲突
③ 没下发网关/DNS → "能拿到 IP 但上不了网"
```

### NTP 为什么必须准

```
① TLS 证书有效期校验依赖时间（差太多直接握手失败）
② 日志排序、审计取证依赖时间
③ 分布式锁/租约（etcd、Patroni）依赖时间近似一致
④ 令牌/JWT 过期判断依赖时间
```

**机制**：NTP 不是"直接改时间"，而是"估算偏移 + 渐进调整（slew）"，避免时间跳变。

### 三个服务的依赖关系

```
DHCP 通过 option 告诉客户端"DNS 是谁"
DNS 解析"时间服务器是谁"（可选）
所有机器指向内网 NTP（NTP 再向上游同步）
→ 这三者构成内网"基础设施底座"
```

### 什么情况自建

```
自建：内网域名（app.corp.local）、办公网自动分配、隔离环境无外网
不自建：云上单机小环境（用云 DNS/DHCP 更省事）
```

### 为什么自建

```
① 内网域名解析（app.corp.local）
② 统一出口与缓存（加速 + 减少外网查询）
③ 时间同步（证书/日志/集群一致性）
④ 地址自动分配（办公网/实验环境）
```

**"全靠外网 DNS"** → 内网服务要用 IP，迁移困难。

### dnsmasq：小网络够用

```bash
dnf install -y dnsmasq
```

```conf
# /etc/dnsmasq.conf
domain-needed
bogus-priv
no-resolv
server=223.5.5.5
server=8.8.8.8
local=/corp.local/
address=/app.corp.local/10.0.0.20
address=/db.corp.local/10.0.0.21
```

```bash
systemctl enable --now dnsmasq
dig @127.0.0.1 app.corp.local +short
```

**"把内网域名配在上游 DNS"** → 上游不知道，解析失败。

### BIND：正经的内网权威

```conf
// named.conf 片段
zone "corp.local" {
    type master;
    file "/var/named/corp.local.zone";
};
```

```conf
; corp.local.zone
$TTL 600
@   IN SOA ns1.corp.local. admin.corp.local. (2026112701 3600 600 86400 600)
@   IN NS  ns1.corp.local.
ns1 IN A   10.0.0.10
app IN A   10.0.0.20
db  IN A   10.0.0.21
```

```bash
named-checkzone corp.local /var/named/corp.local.zone
rndc reload
```

**"手改 zone 不检查"** → 语法错会让整个 zone 不加载。

### DHCP：保留地址

```conf
# dnsmasq
dhcp-range=10.0.0.100,10.0.0.200,12h
dhcp-option=3,10.0.0.1
dhcp-option=6,10.0.0.10
dhcp-host=aa:bb:cc:dd:ee:ff,10.0.0.50    # 打印机固定 IP
```

**要点**：

```
① 地址池不要与静态 IP 重叠
② 网关与 DNS 通过 option 下发
③ 关键设备（打印机/AP/服务器）用保留
```

### NTP：时间必须一致

```bash
dnf install -y chrony
```

```conf
# /etc/chrony.conf
server ntp.aliyun.com iburst
server time.cloudflare.com iburst
allow 10.0.0.0/24        # 允许内网客户端同步
local stratum 10
```

```bash
systemctl enable --now chronyd
chronyc sources -v
chronyc tracking
```

**判据**：

```
System time offset < 50ms（一般够）
过大 → 检查上游可达与防火墙（UDP 123）
```

**"集群时间差几分钟"** → 证书校验失败、日志错乱、分布式锁异常。

### 五个"内网服务互相打架"

**① 两套 DHCP**

```
一个路由器 + 一台服务器都发地址 → 地址冲突
```

**② 环路 + DHCP**

```
DHCP 请求在环路里打转 → 地址池耗尽
```

**③ DNS 双份答案**

```
dnsmasq 与 BIND 都配置了不同记录
```

**④ 时间源不一致**

```
部分机器同步外网、部分同步内网 → 差几秒
```

**⑤ 防火墙挡了基础协议**

```
UDP 53/67/68/123 被拦 → "莫名其妙不能上网"
```

### 一个"够用"的内网基础服务清单

```
① 一台 DNS（dnsmasq 或 BIND），内网域名 + 上游转发
② DHCP（地址池 + 保留）
③ NTP（内网一主一备，客户端指向内网）
④ 监控：解析成功率、地址池使用率、时间偏移
```

### 检查清单

```
□ 内网域名有记录（不是写 IP）
□ DHCP 只有一套
□ 地址池不与静态重叠
□ 关键设备有保留
□ NTP 内网源 + 客户端统一
□ 基础协议端口放行
□ 有解析/池/偏移监控
□ 有备份配置
□ 变更前 named-checkzone/语法检查
□ 有回滚（保留上一版配置）
```
