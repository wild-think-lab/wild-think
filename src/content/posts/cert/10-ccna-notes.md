---
title: CCNA 笔记：路由交换里"考试与工作都考"的部分
description: 子网划分心算、OSPF 与 VLAN 的关键配置、ACL 顺序陷阱，以及五个"配了不生效"的原因。
date: 2024-01-18
tags: [网络, CCNA, 认证]
---

### 一、子网心算（必须练到 10 秒）

```
/24 → 255.255.255.0    每段 256，可用 254
/25 → 255.255.255.128  每段 128，可用 126
/26 → 255.255.255.192  每段 64
/27 → 255.255.255.224  每段 32
/28 → 255.255.255.240  每段 16
/29 → 255.255.255.248  每段 8
/30 → 255.255.255.252  每段 4（可用 2，点对点）
```

**心算技巧**：

```
主机位 h = 32 - 前缀
每段大小 = 2^h
网络号 = 该段起点（向下对齐到 2^h 的倍数）
```

**例**：`192.168.10.100/26`

```
h=6 → 每段 64 → 100 落在 64–127 → 网络号 192.168.10.64
广播 = 127，可用 65–126
```

### 二、VLAN 与 Trunk

```
① Access 口：只属一个 VLAN
② Trunk 口：承载多个 VLAN（打标签 802.1Q）
③ 本征 VLAN（native）：Trunk 上不打标签的那个
```

```bash
vlan 10
 name app
interface GigabitEthernet0/1
 switchport mode access
 switchport access vlan 10
interface GigabitEthernet0/2
 switchport mode trunk
 switchport trunk allowed vlan 10,20
```

**"两端 native VLAN 不一致"** 会导致流量串 VLAN（安全问题）：

```
必须两端一致（或改成非 1 的值并保持一致）
```

### 三、OSPF 最小配置

```bash
router ospf 1
 network 10.0.0.0 0.0.0.255 area 0
 network 192.168.1.0 0.0.0.255 area 0
```

**关键点**：

```
① 通配符（wildcard）不是子网掩码（反着写）
② 邻居要"同区域、同网段、同 MTU"
③ 默认 hello 10s / dead 40s（广播网络）
```

**检查**：

```bash
show ip ospf neighbor
show ip ospf interface
show ip route ospf
```

**"邻居卡在 INIT/EXSTART"**：

```
INIT      ：收到 hello 但没被对方认可 → 单向通信问题
EXSTART   ：MTU 不一致（最常见）
```

**"EXSTART 卡住"** → 90% 是 MTU 不一致。

### 四、静态路由与默认路由

```bash
ip route 0.0.0.0 0.0.0.0 10.0.0.1
ip route 172.16.0.0 255.255.0.0 10.0.0.2
```

**浮动静态路由**：

```bash
ip route 0.0.0.0 0.0.0.0 10.0.0.1 1
ip route 0.0.0.0 0.0.0.0 10.0.0.3 10    # 备份，AD 更大
```

**"AD（管理距离）"** 决定优先级（越小越优先）。

### 五、ACL 的顺序陷阱

```
ACL 从上到下匹配，命中即停
末尾隐含 deny all
```

```bash
access-list 10 permit 10.1.1.0 0.0.0.255
access-list 10 deny any
```

**五个常见错误**：

```
① 顺序错（deny 写在 permit 前面 → 全被拒）
② 通配符写错（0.0.0.255 而不是 255.255.255.0）
③ 方向错（in vs out 搞反）
④ 应用在错误接口
⑤ 忘了"隐含 deny"
```

**"ping 不通但 ACL 看着没问题"** → 先查方向与顺序。

### 六、NAT 三种

```bash
# 静态 NAT（一对一）
ip nat inside source static 10.0.0.10 203.0.113.10

# 动态 NAT（池）
ip nat pool pub 203.0.113.20 203.0.113.30 netmask 255.255.255.0
ip nat inside source list 1 pool pub

# PAT（端口复用，最常用）
ip nat inside source list 1 interface GigabitEthernet0/0 overload
```

**关键**：

```
① 必须标 inside/outside 接口
② ACL 只匹配"需要 NAT 的源"
```

**"NAT 配了但不生效"** → 接口没标 inside/outside。

### 七、五个"配了不生效"的原因

**① 接口没启用**

```bash
interface Gi0/1
 no shutdown
```

**② 路由缺失**

```
能 ping 通直连，不通远端 → 查路由表
```

**③ VLAN 未创建 / 端口未划入**

```bash
show vlan brief
```

**④ STP 阻塞**

```bash
show spanning-tree
# 端口状态 BLK → 被 STP 阻断（可能环路）
```

**⑤ 防火墙/ACL 拦截**

```
先抓包或看 ACL 命中计数
show ip access-list
```

### 八、排障顺序（网络层）

```
1) 物理/链路：show interface（up/up？错包？）
2) 二层：VLAN / STP / Trunk
3) 三层：IP/掩码/路由
4) 四层：ACL / NAT
5) 应用：DNS / 端口监听
```

**"从下往上"** 比"猜"快。

### 检查清单

```
□ 子网划分能 10 秒心算
□ Trunk 两端 native VLAN 一致
□ OSPF 邻居关系检查（EXSTART=MTU）
□ 静态路由有浮动备份
□ ACL 顺序与方向正确
□ NAT 接口标了 inside/outside
□ 接口 no shutdown
□ 会看 show interface 的错误计数
□ 会看 STP 状态
□ 排障按"下往上"顺序
```
