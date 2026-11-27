---
title: IPsec：站点互联里最容易"通一半"的协议
description: IKE 两阶段、ESP 与 AH、隧道与传输模式、NAT-T 与常见参数错误，五个"能建隧道但业务不通"的原因。
date: 2026-11-25
tags: [网络, VPN, IPsec]
---

### 两大阶段

```
IKE Phase 1：建立"管理通道"（认证双方，协商加密）
IKE Phase 2：协商"数据通道"（IPsec SA，真正传业务）
```

**"Phase 1 通、Phase 2 失败"** → 是"提议（proposal）不匹配"，不是网络问题。

### 两种协议

```
AH：只认证（不改包，但会被 NAT 破坏）
ESP：加密 + 认证（主流）
```

**用 AH 穿 NAT** → 一定失败（NAT 会改地址，破坏完整性校验）。

### 两种模式

```
传输模式（Transport）：只加密载荷（主机到主机）
隧道模式（Tunnel）：整包封装（网关到网关）
```

**站点互联** → 隧道模式（默认）。

### 一个 StrongSwan 配置

```conf
conn site-a
    keyexchange=ikev2
    left=203.0.113.1
    leftsubnet=10.1.0.0/16
    right=198.51.100.1
    rightsubnet=10.2.0.0/16
    authby=secret
    ike=aes256-sha256-modp2048
    esp=aes256-sha256
    auto=start
```

**两边 `ike`/`esp` 必须完全一致**（包括 DH 组）。

### 五个"能建隧道但业务不通"

**① 子网没匹配**

```
leftsubnet/rightsubnet 与实际流量不符
→ 隧道起来了，但流量没走进去
```

**② 路由没指过去**

```
到对端网段的路由要指向 VPN 接口（不是默认网关）
```

**③ 防火墙拦了 ESP（协议号 50）**

```
只放行 UDP 500/4500 → 隧道建立成功，数据包被丢
```

**④ NAT-T 没开**

```
一侧在 NAT 后面 → 必须 UDP 4500 封装
```

**⑤ 重叠网段**

```
两边都是 192.168.1.0/24 → 路由冲突（必须先改网段）
```

### 排查顺序

```bash
# 1) 看 SA 是否建立
ipsec statusall          # strongSwan
# 2) 看 IKE 日志
journalctl -u strongswan -n 100
# 3) 抓包
tcpdump -i any -nn 'udp port 500 or udp port 4500 or esp'
# 4) 看路由与策略
ip xfrm policy
ip xfrm state
```

**判据**：

```
有 IKE 但没有 ESP 包 → 提议不匹配或防火墙拦 ESP
有 ESP 但没有业务回包 → 路由/子网/策略问题
```

### 五个参数细节

```
① PFS（完美前向保密）：两边要一致（开/关）
② lifetime（SA 有效期）：不一致会"周期性断一下"
③ DH 组：必须相同（如 modp2048）
④ 认证方式：PSK/证书不能混用
⑤ NAT-T 范围：默认自动，跨 NAT 要显式开
```

### 什么时候用 IPsec vs WireGuard

```
IPsec：与设备/云厂商互通（标准）、策略细
WireGuard：简单、快、配置少（自有网络优先）
```

**"云上专线"** 多数云厂商提供 IPsec 网关（按标准走）。

### 检查清单

```
□ 两边网段不重叠
□ ike/esp 提议完全一致
□ PFS/DH 组一致
□ lifetime 一致
□ 放行 UDP 500/4500 + ESP
□ NAT 场景开 NAT-T
□ 到对端网段的路由指向隧道
□ 有 SA 状态监控
□ 有"重建隧道"的脚本
□ 有断线自动重连
```
