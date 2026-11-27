---
title: BGP 入门：多线接入与路由选路
module: 进阶篇
summary: AS/对等/邻居建立、常见属性与选路顺序、多线接入的落地姿势，五个"配完不通"的原因。
minutes: 50
---

### 什么时候才需要 BGP

```
① 需要多运营商线路且自动切换
② 有自有 AS 与 IP 段（或运营商分配）
③ 跨机房建立骨干
```

**"单线小公司上 BGP"** → 复杂度和收益不成正比，用策略路由就够。

### 三个基本概念

```
AS：自治系统（一个管理域，有 ASN）
eBGP：不同 AS 之间（通常直连）
iBGP：同一 AS 内（全互联或用路由反射器）
```

**iBGP 关键**：默认不转发（防环），要么全互联，要么用 RR。

### 邻居建立

```bash
# Cisco 风格
router bgp 65001
 neighbor 203.0.113.1 remote-as 65010
 neighbor 203.0.113.1 description ISP-A
 network 198.51.100.0 mask 255.255.255.0
```

```bash
# 验证
show ip bgp summary          # State 应为 "Pcr"（已建立）
show ip bgp neighbors 203.0.113.1
show ip route bgp
```

**"Idle/PfxCt"** 通常是端口 179 被拦、源地址不对、或 AS 号配置错。

### 常见属性（决定选路）

```
① Weight（本地，Cisco 私有）：越大越优先
② Local Preference：AS 内统一，越大越优先（出方向选路）
③ AS_PATH：越短越优先
④ MED：向对端建议入口，越小越优先
⑤ Origin：IGP < EGP < incomplete
```

**选路顺序（简化）**：Weight → LocalPref → 本地始发 → AS_PATH 短 → Origin → MED → eBGP 优于 iBGP → 最近邻居。

**"改了半天不生效"** → 要看清当前比较到哪一级。

### 多线接入落地

```
① 每条线一个 eBGP 邻居
② 主备：LocalPref 区分（主动高）
③ 分流：按目标段用 AS_PATH 或 LocalPref 调整
④ 出方向策略：prefix-list + route-map
```

```bash
route-map FROM-ISP-A in
 match ip address prefix-list CUST-NETS
 set local-preference 200
```

**注意**：入方向（别人怎么把流量给你）由对端决定，通常靠 MED 或长短前缀。

### 五个"配完不通"

**① 没宣告自己的段**

```
邻居建立了，但路由表里没有你的前缀
```

**② 只宣告不加掩码**

```
宣告了 /24 却用 /8 掩码 → 无效
```

**③ 防火墙挡 179**

```
TCP 179 双向都要通
```

**④ 回程路由缺失**

```
只做了去方向策略，回来的包没路由
```

**⑤ 双线都指默认路由**

```
没有策略 → 全部走一条，另一条闲着
```

### 安全（很重要）

```
① 只和对端约定过的 IP 建邻居
② 用 BGP 密码（TCP MD5）
③ 入方向过滤：只接受对方该给你的前缀
④ 防前缀劫持：限制最大前缀数
```

**"没有入方向过滤"** → 对端误配置能把你的流量全带走。

### 检查清单

```
□ 有自有/分配 IP 段与 ASN
□ 邻居状态稳定（有监控）
□ 179 端口双向可达
□ 有 BGP 密码
□ 入方向前缀过滤
□ 最大前缀数限制
□ LocalPref/AS_PATH 策略有文档
□ 回程路由已验证
□ 有双线切换演练
□ 有路由变化告警
```
