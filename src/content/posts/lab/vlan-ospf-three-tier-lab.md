---
title: 实验：三层交换机上做 VLAN 间路由 + OSPF 互通
description: 从零搭一个"两台三层交换机 + 两端接入 VLAN"的实验，含完整配置、验证命令、以及四个必踩的坑。
date: 2025-03-26
tags: [实验, VLAN, OSPF, 路由交换, 华为]
---

目标：两台接入交换机各带一个 VLAN，通过三层交换机互联，两个 VLAN 之间能互通，并且路径由 OSPF 动态学习而不是静态路由。

## 一、拓扑与地址规划

```
PC1(192.168.10.10) ── SW1(VLAN10) ── L3-A(Vlanif10 192.168.10.1)
                                      │
                              (10.0.0.0/30 互联)
                                      │
                              L3-B(Vlanif20 192.168.20.1)
                                      │
                     SW2(VLAN20) ── PC2(192.168.20.10)
```

| 设备 | 接口 | 地址/配置 |
| --- | --- | --- |
| L3-A | Vlanif10 | 192.168.10.1/24 |
| L3-A | Vlanif100 | 10.0.0.1/30（互联） |
| L3-B | Vlanif20 | 192.168.20.1/24 |
| L3-B | Vlanif100 | 10.0.0.2/30 |

## 二、二层准备（SW1 / SW2）

```text
# SW1
vlan batch 10
interface GigabitEthernet0/0/1
 port link-type access
 port default vlan 10
interface GigabitEthernet0/0/2
 port link-type trunk
 port trunk allow-pass vlan 10
```

```text
# SW2
vlan batch 20
interface GigabitEthernet0/0/1
 port link-type access
 port default vlan 20
interface GigabitEthernet0/0/2
 port link-type trunk
 port trunk allow-pass vlan 20
```

关键点：trunk 上**必须显式放行对应 VLAN**。华为默认只放行 VLAN 1，漏了这一步的现象是"PC 起不来、ARP 学不到"。

## 三、三层与 OSPF（L3-A / L3-B）

```text
# L3-A
vlan batch 10 100
interface GigabitEthernet0/0/1
 port link-type trunk
 port trunk allow-pass vlan 10
interface GigabitEthernet0/0/2
 port link-type access
 port default vlan 100

interface Vlanif10
 ip address 192.168.10.1 24
interface Vlanif100
 ip address 10.0.0.1 30

ospf 1 router-id 1.1.1.1
 area 0
  network 10.0.0.0 0.0.0.3
  network 192.168.10.0 0.0.0.255
```

```text
# L3-B
vlan batch 20 100
interface GigabitEthernet0/0/1
 port link-type trunk
 port trunk allow-pass vlan 20
interface GigabitEthernet0/0/2
 port link-type access
 port default vlan 100

interface Vlanif20
 ip address 192.168.20.1 24
interface Vlanif100
 ip address 10.0.0.2 30

ospf 1 router-id 2.2.2.2
 area 0
  network 10.0.0.0 0.0.0.3
  network 192.168.20.0 0.0.0.255
```

**注意**：`network` 用的是反掩码。`0.0.0.3` 对应 /30，`0.0.0.255` 对应 /24。写成正掩码是最常见的配置错误。

## 四、验证五步

```bash
# 1) 邻接关系
display ospf peer brief          # 期望 Full

# 2) 路由表里有对方的业务网段
display ip routing-table protocol ospf | include 192.168
# 期望：192.168.20.0/24  OSPF  10.0.0.2 ...

# 3) 端到端连通
ping -a 192.168.10.10 192.168.20.10    # 从 PC1 视角（部分设备支持 -a 指定源）

# 4) 路径确认
tracert 192.168.20.10                  # 应看到两跳

# 5) 反向也通（单向通是最容易漏的）
# 在 PC2 上 ping 192.168.10.10
```

## 五、四个必踩的坑

1. **trunk 未放行 VLAN**：现象是同 VLAN 内 PC 之间都不通。判据 `display port vlan` 看 trunk 的实际允许列表。
2. **Vlanif 状态 Down**：VLAN 里没有 Up 的成员口时，Vlanif 会 Down（除非配置 `undo shutdown` 且存在 Up 口）。`display ip interface brief` 能看到 `DOWN`。
3. **OSPF 宣告了错误的网段**：宣告 `192.168.10.0 0.0.0.255` 而接口是 /24 没问题，但若接口是 /25 却宣告 /24，会把不属于自己的网段一起通告，形成黑洞路由。
4. **PC 网关配错**：VLAN 10 的 PC 网关必须是 `192.168.10.1`；写成互联地址 `10.0.0.1` 时同 VLAN 可通、跨 VLAN 不通。

## 六、加练：把实验变成可交付的报告

记录这三张表，才算完成一次"实验"而不是"点了几下命令"：

| 表 | 内容 |
| --- | --- |
| 地址表 | 设备/接口/VLAN/IP/掩码 |
| 邻接表 | OSPF 邻居、状态、Router ID |
| 路由表 | 目的网段、下一跳、出接口、开销 |

再补一段"故障注入"记录：把 L3-B 的 `Vlanif100` 关掉，观察路由撤销时间（默认 Dead 40s），恢复后重新收敛——这条能证明 OSPF 计时器真的生效。

> 一句话：**三层互通的验证顺序永远是 二层 → 接口状态 → 路由表 → 端到端 → 反向。跳过任何一步，都会把问题猜错层。**
