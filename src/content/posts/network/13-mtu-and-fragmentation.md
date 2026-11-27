---
title: MTU 与分片：VPN 通了但网页打不开
description: MTU 是怎么把"能 ping 通"和"能打开网页"分开的、MSS 钳制的原理、四种检测方法，以及云环境里的常见值。
date: 2023-08-29
tags: [网络, MTU, VPN, 排障]
---

### 一个经典故障

```
现象：
  ping 网关通、ping 外网通
  但访问 https 页面卡住、SSH 登录后卡死
  小文件能传，大文件传一半断

原因：MTU 不匹配，大包被丢弃且没有正确的 ICMP 反馈
```

**"能 ping 通"只证明小包（64 字节）通**，大包可能是另一回事。

### MTU 与分片基础

```
标准以太网 MTU = 1500
隧道（VXLAN/GRE/IPSec）会再加封装头：
  VXLAN   +50
  GRE     +24
  IPSec   +50~70
→ 隧道内的可用 MTU 变成 1450 或更低
```

如果隧道内还按 1500 发包：

```
大包 → 加封装后超过物理 MTU → 被丢弃
→ 如果 ICMP "需要分片" 消息被防火墙拦掉（很常见）
→ 发送方不知道，一直重传 → 应用层"卡住"
```

**这就是"MTU 黑洞"**。

### 检测方法（四种）

**① ping 带 DF 标志，二分找最大包**

```bash
# Linux
ping -M do -s 1472 -c 3 8.8.8.8     # 1472 + 28 = 1500
ping -M do -s 1400 -c 3 8.8.8.8
ping -M do -s 1200 -c 3 8.8.8.8

# 逐步试，找到"刚好不通"的值
```

**② 用 tracepath 直接看**

```bash
tracepath -n 8.8.8.8
# 输出里有 "pmtu 1500" 或 "pmtu 1450" 及 "asymm" 提示
```

**③ 用 tcpdump 看是否发出大包**

```bash
tcpdump -i eth0 -nn 'tcp and greater 1472'
# 如果有大量大包重传 → MTU 问题
```

**④ 直接测 HTTP（最贴近真实）**

```bash
curl -v --max-time 10 https://example.com/large-file
# 卡在 "expecting response" → 可能 MTU
```

### MSS 钳制（标准解法）

```bash
# 在转发设备（路由器/网关）上
iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --clamp-mss-to-pmtu
```

原理：在 TCP 三次握手的 SYN 包里改写 MSS 选项，告诉对端"我只能收这么小的段"。

**这是修 MTU 问题最通用的方案**：不用改每台机器。

MSS 计算：

```
MSS = MTU - 20(IP 头) - 20(TCP 头)
1500 → MSS 1460
1450 → MSS 1410
1400 → MSS 1360
```

### 各环境的常见 MTU

| 环境 | MTU |
| --- | --- |
| 标准以太网 | 1500 |
| VXLAN（K8s overlay） | 1450 |
| IPSec VPN | 1400 或更低 |
| PPPoE（拨号上网） | 1492 |
| WireGuard | 1420 |
| 部分云内网 | 1500 或 9000（jumbo） |

**PPPoE 的 1492 是家庭宽带最常见的坑**：路由器没正确设 MTU 时，网页会"打不开一半"。

### 修改 MTU

```bash
# 临时
ip link set dev eth0 mtu 1450
# 永久（NetworkManager）
nmcli connection modify eth0 802-3-ethernet.mtu 1450
nmcli connection up eth0
# systemd-networkd
# /etc/systemd/network/10-eth0.network
[Link]
MTUBytes=1450
```

**改小是安全的**（性能略降），**改大要确认整条链路都支持**（jumbo frame 需要交换机/网卡全支持）。

### 云环境里的特殊情况

```
① 云主机的内网 MTU 可能是 1500，但隧道后是 1450
② 容器网络（overlay）通常要设 1450
③ 跨云专线的 MTU 可能更小
④ 云厂商的安全组/ACL 可能丢弃 ICMP，导致"黑洞"
```

**K8s 场景**：

```yaml
# Calico VXLAN 默认 MTU 会自动算（一般是 1450）
# 手工指定（防止算错）
- name: veth_mtu
  value: "1450"
```

### 排查顺序

```
① 小包通吗？（ping 网关、ping 外网）
② 大包通吗？（ping -M do -s 1472）
③ 哪个尺寸开始不通？（二分）
④ 是隧道吗？（VXLAN/IPSec/WireGuard）
⑤ 中间设备是否丢 ICMP？（黑洞确认）
⑥ 加 MSS 钳制或改 MTU
```

### 检查清单

```
□ 隧道环境 MTU 按封装开销调小
□ 网关/路由器开了 MSS 钳制
□ 不阻塞 ICMP type 3 code 4（需要分片）
□ K8s overlay 的 MTU 正确（通常 1450）
□ PPPoE 环境设 1492
□ 有"大包测试"作为连通性验证的一部分
```
