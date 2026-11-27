---
title: BGP 入门：从"两条宽带"讲到选路规则
description: AS 与 BGP 到底在解决什么问题、eBGP 与 iBGP 的差别、一条最小可用的宣告配置、BGP 七步选路怎么用，以及邻居起不来的排查顺序。
date: 2022-02-09
tags: [BGP, 路由, 网络, 运营商, 排障]
---

### 先想清楚 BGP 解决什么

OSPF、静态路由这类协议，默认假设"网络里所有人互相信任"。而 BGP 解决的是**互不信任的组织之间怎么交换路由**：电信不知道联通内部拓扑，也不需要知道，它只需要知道"去某个网段，交给联通那个口就行"。

所以 BGP 的三个关键词：**AS（自治系统）**、**策略**、**可达性**。

- AS：一个管理域，用 AS 号标识（16 位 1–65535，32 位更大）。企业申请私用 AS 号（64512–65534）就够做双线接入。
- 策略：BGP 几乎不关心"哪条路最短"，它关心"我允许你告诉我什么、我允许往外说什么"。AS-PATH 长度只是众多因素之一。
- 可达性：BGP 是路径向量协议，它传的不是"到某点的距离"，而是"到某点的完整 AS 序列"。这个序列天然防环——看到自己的 AS 号在里面就丢弃。

### eBGP 与 iBGP：一句话区分

| | eBGP | iBGP |
| --- | --- | --- |
| 邻居关系 | 跨 AS | 同 AS 内部 |
| 默认要求直连 | 是（默认 TTL=1） | 否，通常靠回环口建立 |
| 下一跳 | 会被改写为邻居地址 | **不会被改写**，需要 `next-hop-self` 或全网全互联 |
| 防环 | AS-PATH | AS-PATH（同 AS 内不重复，所以要全互联或联邦/路由反射器） |

iBGP 有个著名约束：**一条 iBGP 学来的路由，不会再传给另一个 iBGP 邻居**（防止环路）。所以同一 AS 内有 N 台路由器时，要么两两全互联（N(N-1)/2 条会话），要么用路由反射器（RR），要么用联邦。

### 一条最小可用的双线接入配置

场景：企业一条电信、一条联通，各拿一个 /29，希望出流量按目的网段选线，入流量由运营商决定。

以 Cisco 语法为例（华为/中兴只是命令词不同）：

```
router bgp 64512
 bgp log-neighbor-changes
 !
 ! 电信侧
 neighbor 202.1.1.1 remote-as 4134
 neighbor 202.1.1.1 description ISP-TELECOM
 !
 ! 联通侧
 neighbor 202.2.2.1 remote-as 9929
 neighbor 202.2.2.1 description ISP-UNICOM
 !
 ! 宣告自己的地址段（必须是你真正持有的）
 network 203.0.113.0 mask 255.255.255.248
 !
 ! 只接受"看起来正常"的路由，挡掉明显伪造
 neighbor 202.1.1.1 maximum-prefix 2000 90
 neighbor 202.2.2.1 maximum-prefix 2000 90
```

要理解两件事：

1. `network` 语句只宣告"我本地有这条路由"的网段，不是宣告整个表。
2. 上游给不给你全表，取决于合同和 `neighbor ... default-originate` / `soft-reconfiguration` 之类的约定。中小企业常见做法是**只收默认路由**（`neighbor x.x.x.x default-originate` 是上游侧动作，本地侧表现为只看到 `0.0.0.0/0`），这样设备内存压力小很多。

### BGP 七步选路，记住前四条就够用

路由器收到同一目的网段的多条 BGP 路由时，按顺序比较：

1. **Weight**（Cisco 私有，本机越大越优先）
2. **Local Preference**（越大越优先，只在 AS 内传播，是最常用的"选出口"手段）
3. **本地始发**（自己 network 出去的优先）
4. **AS-PATH 最短**
5. Origin（IGP < EGP < incomplete）
6. MED（越小越优先，用来告诉上游"请从这边进"）
7. eBGP 优于 iBGP；再比 IGP 到下一跳的 cost；最后比邻居地址小者优先

实践里 90% 的需求靠 **Local Preference** 解决：

```
! 让联通成为主出口（对本 AS 内所有路由器生效）
ip route 10.0.0.0 255.0.0.0 null0   ! 需要有匹配路由才能挂 route-map
!
route-map PREF-UNICOM permit 10
 set local-preference 200
route-map PREF-TELECOM permit 10
 set local-preference 100
!
router bgp 64512
 neighbor 202.2.2.1 route-map PREF-UNICOM in
 neighbor 202.1.1.1 route-map PREF-TELECOM in
```

Local Preference 是"出口偏好"，**影响不了别人怎么进来**。想让入流量走某条线，只能靠：

- 对上游宣告更长掩码（更具体的网段）——但很多上游会过滤 /25 以上；
- 用 MED（只在相邻 AS 之间有效，且要求对方按你的 MED 选）；
- 或者干脆接受"入向由运营商决定"这个现实。

### 邻居起不来，按这个顺序查

```
show bgp summary          ! 状态是不是 Established，有没有一直 Active/Idle
show tcp brief all        ! 179 端口有没有连上
show ip bgp neighbors 202.1.1.1   ! 看 last reset reason
```

常见原因，从高到低：

1. **179 被墙**：中间防火墙/安全组没放行 TCP 179。BGP 走的是 TCP，不是 UDP，很多人第一反应会配错。
2. **AS 号不匹配**：本地 `remote-as` 写错，对方会直接发 Notification 断开。
3. **源地址不对**：多出口环境下 BGP 用错源 IP 建连，对方按邻居配置对不上。用 `neighbor x.x.x.x update-source` 指定。
4. **TTL 不够**：eBGP 默认 TTL=1，跨了一台设备就起不来，需要 `neighbor ... ebgp-multihop 2`（这属于配置风险，谨慎）。
5. **认证不一致**：一边配了 `neighbor ... password`，另一边没配。
6. **收到 Notification**：`show ip bgp neighbors` 里能看到具体原因码，比猜快得多。

### 两条容易踩的坑

**坑一：宣告了不属于自己的网段。** 上游一般会有 bogon/前缀过滤，轻则被丢弃，重则被判定为路由劫持。只宣告自己合同内的地址段。

**坑二：iBGP 下一跳不可达。** iBGP 不改写下一跳，如果内部没有到"邻居的下一跳地址"的 IGP 路由，路由会进入表但标记为不可用（`show ip bgp` 里前面没有 `>`）。排查时先看 IGP 通不通，再看 BGP。

### 一句话总结

BGP 不是"找最短路径"的协议，而是"按商业关系交换可达性"的协议。配置只占三行，剩下全靠策略与清洗。
