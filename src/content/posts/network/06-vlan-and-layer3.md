---
title: VLAN 与三层交换：企业网络最基础的那一层
description: 广播域为什么必须切开、Access 与 Trunk 的差别、交换机间怎么走、VLAN 间怎么通信，以及"跨 VLAN 不通"的五步排查。
date: 2026-11-27
tags: [VLAN, 三层交换, 网络, 交换机, 排障]
---

### 为什么要有 VLAN

一个二层网络里，广播帧会被发给所有端口。200 台机器的广播风暴能直接把交换机打瘫。

VLAN 的作用：**在物理交换机上切出多个逻辑网络**。同一 VLAN 内互通，不同 VLAN 默认隔离。

顺带的好处：隔离广播、按部门划分、减少攻击面。

### Access 与 Trunk

| 端口类型 | 承载 | 用在哪 |
| --- | --- | --- |
| Access | 单个 VLAN，出端口不打标签 | 接电脑、服务器、打印机 |
| Trunk | 多个 VLAN，帧带 VLAN Tag | 接交换机、接三层设备 |

```
核心交换机 SW-CORE
  ├─ Trunk (VLAN 10/20/30) → 接入交换机 SW-A
  │     ├─ Access VLAN10 → 财务部 PC
  │     └─ Access VLAN20 → 研发部 PC
  └─ Trunk → 防火墙/路由
```

一句话记：**终端侧 Access，交换机之间 Trunk。**

### 配置示例（以华为/思科风格，概念通用）

```bash
# 接入交换机
vlan 10,20
interface GigabitEthernet0/1
  port link-type access
  port default vlan 10
interface GigabitEthernet0/24
  port link-type trunk
  port trunk allow-pass vlan 10 20
```

```bash
# 思科
switchport mode access
switchport access vlan 10
switchport mode trunk
switchport trunk allowed vlan 10,20
```

**Trunk 一定要写 `allow-pass` 白名单**，默认放行所有 VLAN 会让无关广播四处扩散（也是最常见的配置事故）。

### VLAN 之间怎么通

二层只负责同 VLAN 内转发。跨 VLAN 必须经过三层：

方式一：**三层交换机 SVI**

```
interface Vlanif10
  ip address 10.10.10.1 255.255.255.0
interface Vlanif20
  ip address 10.10.20.1 255.255.255.0
ip route-static 0.0.0.0 0 10.10.10.254
```

方式二：**单臂路由（子接口）**

```
interface GigabitEthernet0/0.10
  encapsulation dot1Q 10
  ip address 10.10.10.1 255.255.255.0
```

方式三：防火墙做网关（安全域划分更清晰，但性能与规则复杂度更高）。

小规模建议三层交换机；有安全合规要求（如等保区域划分）建议防火墙。

### 环路与 STP

多台交换机互连很容易形成环路，一个广播帧会无限循环。STP 自动阻断冗余链路。

```bash
display stp brief        # 华为
show spanning-tree       # 思科
```

要点：

- 接入交换机上开 **PortFast / edge port**，否则终端插上要等 30 秒才能上网。
- 核心侧不要随意改 STP 优先级，规划好根桥。
- 现代环境可以上 RSTP/MSTP，收敛从 30 秒降到秒级。

### "跨 VLAN 不通"的五步排查

1. **端口 VLAN 对吗**

```bash
display interface GigabitEthernet0/1 | grep -i vlan
```

2. **Trunk 放行了吗**

```bash
display port vlan
```

常见错误：中间某台交换机的 Trunk 没放行目标 VLAN，两端看起来配置都对，就是不通。

3. **网关存在吗**

```bash
display ip interface brief
```

`Vlanif20` 没有 IP，这个 VLAN 就没有网关。

4. **终端网关指对了吗**

客户端网关必须指向本 VLAN 的网关地址，不是核心交换机管理地址。

5. **ACL / 防火墙策略拦了吗**

```bash
display acl all
```

跨 VLAN 通了但业务端口不通，往往是 ACL 或防火墙策略。

### 一个真实案例

"新来的同事电脑能上内网，打不开 OA"。

排查：端口 VLAN 对（10）、网关对、能 ping 网关 → 但不能访问 OA 服务器（在 VLAN20）。查 ACL 发现一条规则只放行 VLAN10 到 VLAN10。**跨 VLAN 的访问是三层策略问题，不是二层问题。**

### 设计建议

1. **一个 VLAN 不要超过 200 台终端**，广播与故障域都要控制。
2. VLAN 编号建表管理（10 财务、20 研发、30 服务器、40 访客、50 管理），不要随手分配。
3. 服务器区单独 VLAN，与管理网隔离。
4. 访客网必须与内网隔离，只放行出网。
5. 所有 Trunk 都写白名单，所有网关都有文档记录。

VLAN 是企业网络的地基。**这一层配错，上面所有服务都会表现出"随机不通"**，而排查成本极高。
