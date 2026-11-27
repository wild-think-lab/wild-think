---
title: BGP 入门：机房多线、Anycast 与"为什么我的 IP 突然不通了"
description: BGP 的四类消息、AS 与邻居、多线与 Anycast 的用法、五个"配完不通"的原因。
date: 2026-11-27
tags: [网络, BGP, 路由]
---

### BGP 在解决什么问题

```
静态路由：我手动告诉你去哪
BGP：你和邻居"交换路由信息"，自动学习与切换
```

**典型场景**：

```
① 机房多线（电信/联通/移动各一条）
② 多机房互备（Anycast）
③ 云上混合组网（专线 + VPN）
```

### 四类消息

```
OPEN      建邻居（协商 AS、能力）
UPDATE    发路由（新增/撤销）
KEEPALIVE 保活（默认 60s，超时 180s）
NOTIFICATION 出错断开（会带错误码）
```

**"邻居起不来"** → 看 OPEN 是否被拒（AS 号/版本/认证）。

### 关键概念

```
AS（自治系统）：一个网络的身份（16/32 位）
eBGP：不同 AS 之间
iBGP：同一 AS 内（通常用 route reflector 减少全互联）
前缀（prefix）：你宣告的网段
```

**"iBGP 全互联"** 在节点多时是灾难（N² 连接）→ 用 RR。

### 最小配置（FRR 示例）

```bash
# /etc/frr/frr.conf
router bgp 65001
 bgp router-id 10.0.0.1
 neighbor 10.0.0.2 remote-as 65002
 network 203.0.113.0/24
```

```bash
systemctl enable --now frr
vtysh -c "show bgp summary"
vtysh -c "show ip bgp"
```

### 多线（机房双出口）

```
思路：宣告自己的 /24 给两家运营商，让回程走"更近"的那条
难点：进去与出去方向不一定一致（非对称路由）
```

**常见做法**：

```
① 双线双 IP（DNS 智能解析）— 简单
② 单 IP + BGP 多线（需要 IP 归属自己）— 体验最好
③ SD-WAN 分流 — 灵活但有成本
```

**"以为配了 BGP 就自动最优"** → BGP 选路是按策略，不是按速度。

### Anycast

```
同一个 IP 在多地宣告 → 用户被路由到"网络上最近"的那台
```

**用途**：

```
DNS（1.1.1.1 / 8.8.8.8）、CDN 边缘、抗 DDoS
```

**坑**：

```
① 会话不共享（同一用户可能落到不同节点）
② 有状态协议不适合（除 DNS/QUIC 这类无状态）
③ 需要"路由收敛"监控
```

### 五个"配完不通"

**① 没宣告前缀**

```
邻居起来了，但你没 network 宣告 → 对端学不到
```

**② 前缀被对端过滤**

```
对端只接受"你注册过的前缀"（防劫持）
→ 需要 IRP/注册记录
```

**③ AS 号写错/环路**

```
eBGP 看到自己的 AS 号会丢弃（loop prevention）
```

**④ 防火墙拦了 179/tcp**

```
BGP 端口不通 → 邻居一直 Idle
```

**⑤ 只配了单向**

```
A 宣告给 B，B 没宣告给 A → 只有一边能回
```

### 排障顺序

```
1) 端口通不通（telnet 179 / tcpdump）
2) 邻居状态（show bgp summary：Idle/Active/OpenSent...）
3) 有没有收到路由（show ip bgp neighbors <ip> received-routes）
4) 有没有发出路由（advertised-routes）
5) 选路结果（show ip bgp <prefix>）
6) 实际转发（traceroute 看走向）
```

### 安全：BGP 劫持与防护

```
① 前缀过滤（只接受注册过的）
② TTL 安全（eBGP 默认 1）
③ RPKI（校验前缀归属）
④ 监控（路由突变告警）
```

**"路由突变"** 往往是劫持或误配置的第一信号。

### 检查清单

```
□ 明确 AS 号与前缀归属
□ 邻居状态可监控
□ 有前缀过滤（入/出）
□ 有 RPKI 或至少人工核对
□ 端口 179 放通且限源
□ iBGP 用 RR（不搞全互联）
□ Anycast 只用于无状态服务
□ 有路由变化告警
□ 有 traceroute 双向验证
□ 有"多线切换"演练
```
