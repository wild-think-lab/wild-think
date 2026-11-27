---
title: IPv6 入门与双栈：不是"地址变长了"那么简单
description: 地址结构与前缀分配、SLAAC 与 DHCPv6 的分工、双栈下的 DNS 与优先级、防火墙与 NAT 的消失，以及四个上线必查项。
date: 2026-11-27
tags: [IPv6, 网络, 双栈, DNS]
---

### 地址结构

```
2001:0db8:0000:0000:0000:0000:0000:0001 / 64
└── 全局路由前缀（通常 /48 或 /56 给一个站点）
              └─ 子网 ID（/64，一个 VLAN 一个）
                          └─ 接口 ID（后 64 位，由设备自己生成）
```

关键差异：

| | IPv4 | IPv6 |
| --- | --- | --- |
| 地址长度 | 32 位 | 128 位 |
| 配置方式 | DHCP / 静态 | SLAAC / DHCPv6 / 静态 |
| NAT | 普遍需要 | 设计上不需要 |
| 广播 | 有 | 无（用组播代替） |
| 分片 | 路由器可分片 | **只有源端可分片**（MTU 更关键） |

**/64 是硬规定**：SLAAC 依赖 64 位接口 ID，子网划成 /65 或 /72 会直接导致终端无法自动配置地址。

### SLAAC 与 DHCPv6 的分工

```
SLAAC：路由器发 RA（Router Advertisement），终端自己算地址
DHCPv6：服务器分配地址 + 下发选项（DNS、域名）
```

三种常见组合：

| 模式 | 地址来源 | DNS 来源 | 适用 |
| --- | --- | --- | --- |
| 纯 SLAAC | RA | RA 里的 RDNSS | 简单网络、家庭 |
| SLAAC + DHCPv6 无状态 | RA | DHCPv6 | 企业常见 |
| DHCPv6 有状态 | DHCPv6 | DHCPv6 | 需要集中管理租约 |

Linux 上的开关在 `sysctl`：

```bash
net.ipv6.conf.eth0.accept_ra = 1        # 接受 RA（SLAAC 前提）
net.ipv6.conf.eth0.autoconf = 1         # 允许自动配置
```

**容器/云主机上常见问题**：默认 `accept_ra=0`，导致拿不到 IPv6 地址，看起来"IPv6 不可用"。

### 双栈：四个优先级问题

**① DNS 返回 A 和 AAAA，客户端选哪个？**

现代客户端用 Happy Eyeballs：先试 IPv6，约 250ms 内无响应就回退 IPv4。所以**不能只有 IPv6 而 IPv4 完全不可用**，也不能反过来。

**② 应用只监听 IPv4**

```bash
ss -lntp | grep 8080
# 0.0.0.0:8080  ← 只监听 v4
# [::]:8080     ← 双栈（大多数情况）
```

Nginx 的写法：

```nginx
listen 80;
listen [::]:80;      # 显式加这一行
```

只写 `listen 80` 时，部分系统只监听 IPv4，IPv6 用户直接连不上。

**③ 后端只认 IPv4**

双栈入口 + 单栈后端很常见。要保证代理时正确传递客户端地址：

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
# 或使用 PROXY protocol
```

应用层如果解析客户端 IP 做限流/封禁，必须支持 IPv6 格式。

**④ 日志与统计**

IPv6 地址长，字段长度、正则匹配、数据库列宽都可能不够。

```sql
-- 列宽至少 45 字符（含 IPv4-mapped 形式）
ip VARCHAR(45)
```

### 没有 NAT 意味着什么

IPv4 时代靠 NAT"默认拒绝入向"，IPv6 每个地址都全球可达（如果没防火墙）。

所以：

```
IPv4：默认安全（NAT 挡住了入向）
IPv6：默认暴露（必须显式配防火墙）
```

上线前必须确认：

```bash
ip6tables -L -n | head
# 或者用 nftables
nft list ruleset | grep -A5 ip6
```

云环境通常有安全组，但**自建机房/裸金属必须自己配**。没配就是"所有服务直接暴露在公网"。

### MTU 与分片

IPv6 规定**路由器不分片**，只有源端可以。所以中间链路 MTU 小于报文时，会回 ICMPv6 "Packet Too Big"，源端据此调整。

问题：**ICMPv6 被防火墙拦掉** → 源端不知道要减小 → 大包永远发不出去。

症状与 IPv4 的 MTU 问题相同：小包通、大包卡。

```bash
ping6 -M do -s 1400 <目标>
```

检查 ICMPv6 是否放通（至少 `type 1` Packet Too Big、`type 2` 需要）。

### 上线四查

```
□ 地址：终端能拿到 /64 的地址（ip -6 addr）
□ 路由：有默认路由（ip -6 route | grep default）
□ DNS：AAAA 记录正确（dig AAAA app.example.com）
□ 出向：能访问 IPv6 外网（curl -6 https://ifconfig.co）
```

四条都通，才叫"IPv6 可用"。

### 迁移建议

1. **先内部双栈**：核心服务监听 `[::]`，验证无问题。
2. **再对外提供 IPv6**：DNS 加 AAAA，观察 IPv6 流量占比与错误率。
3. **不要急着去 IPv4**：双栈是长期形态，去 v4 的收益远小于风险。
4. **监控分开看**：v4 与 v6 的错误率要分别统计，混在一起会掩盖单栈问题。

```promql
# 按地址族看错误率
sum by (family) (rate(http_requests_total{status=~"5.."}[5m]))
/ sum by (family) (rate(http_requests_total[5m]))
```
