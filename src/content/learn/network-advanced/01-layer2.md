---
title: 二层：交换机、VLAN 与"同一个网段"到底指什么
module: 入门篇
summary: 从交换机怎么转发帧开始，讲清广播域、VLAN 的隔离，以及"配了 VLAN 还是不通"的几个原因。
minutes: 25
---

### 先说结论

```
交换机靠 MAC 地址转发（二层）
VLAN 把一个物理交换机切成多个"逻辑上的独立交换机"
同一个 VLAN = 同一个广播域
```

**"同一个网段"本质是"同一个广播域"** —— 这句话能解释后面 80% 的困惑。

### 交换机怎么转发一个帧

```
1) 收到帧 → 记录源 MAC 与来源端口（学表）
2) 查目的 MAC：
   ① 表里有 → 只从那个端口发（单播）
   ② 表里没有 → 从除来源外的所有端口发（泛洪）
3) 广播帧（目的 MAC ff:ff:ff:ff:ff:ff）→ 永远泛洪
```

**"泛洪"就是"广播风暴"能打死网络的原因**。

### VLAN 做了什么

```bash
vlan 10
 name app
vlan 20
 name db

interface GigabitEthernet0/1
 switchport mode access
 switchport access vlan 10
```

**一个 access 口只能属于一个 VLAN**：

```
从这台机器发出的帧，不带 VLAN 标签
交换机内部用"端口所属 VLAN"来区分
```

**Trunk 口**（连交换机/路由器）：

```bash
interface GigabitEthernet0/2
 switchport mode trunk
 switchport trunk allowed vlan 10,20
 switchport trunk native vlan 1
```

```
Trunk 上承载多个 VLAN，帧带 802.1Q 标签
本征 VLAN（native）的帧不打标签
```

### 三个"配了 VLAN 还是不通"

**① 两端 native VLAN 不一致**

```
A 端 native=1，B 端 native=10
→ 未打标签的帧被"翻译"到不同 VLAN → 串网/不通
```

**② Trunk 没放行该 VLAN**

```bash
show interfaces trunk
# 看 "VLANs allowed and active in management domain"
```

**③ 缺三层网关**

```
VLAN 之间默认隔离（这是目的）
要互通必须有"三层设备"（路由器/SVI/防火墙）
```

**"同一个交换机上两个 VLAN 却 ping 不通"** → 正常，要看网关在不在。

### 广播域与故障域

```
一个 VLAN 里 500 台机器 → 一次 ARP 泛洪打满链路
→ 按"业务/规模"切 VLAN（一般不超过 200–250 个活跃主机）
```

**"一个 VLAN 塞几百台"** 是很多"网络偶发卡顿"的根源。

### 生成树（STP）为什么重要

```
交换机之间如果有环路 → 广播帧无限循环 → 网络瘫痪
STP 通过"阻塞部分端口"打破环路
```

```bash
show spanning-tree
# 看 Root、各端口状态（FWD/BLK）
```

**"某个端口莫名 BLK"**：

```
① 真环路（设计问题）
② STP 认为环路（两端都开了 spanning-tree 但拓扑异常）
③ 端口配置成"边缘端口"但接了交换机
```

### 一个"看懂二层"的检查顺序

```
1) 端口 up 吗（show interface）
2) 在正确的 VLAN 吗（show vlan brief）
3) Trunk 放行了吗（show interfaces trunk）
4) 有网关吗（三层设备配置）
5) ARP 能学到吗（show arp / arp -a）
```

**"ARP 学不到"** 基本就是二层/网关问题。

### 小结

```
① 交换机看 MAC，VLAN 切广播域
② Trunk 是"多 VLAN 的通道"，native 要一致
③ VLAN 互通必须有三层网关
④ 一个 VLAN 不要太大
⑤ STP 是防环的最后一道
```
