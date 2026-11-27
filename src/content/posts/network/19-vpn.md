---
title: VPN 选型：IPsec、WireGuard、OpenVPN 到底怎么选
description: 三种 VPN 的适用场景与性能差异、WireGuard 的十分钟搭建、以及五个"通了但很慢/很不稳"的原因。
date: 2026-11-27
tags: [网络, VPN, 安全]
---

### 三种主流方案

| 维度 | IPsec | WireGuard | OpenVPN |
| --- | --- | --- | --- |
| 层 | 三层（内核） | 三层（内核） | 四层（用户态） |
| 性能 | 高 | 最高 | 中低 |
| 配置复杂度 | 高（尤其 IKEv2 多厂商） | 低 | 中 |
| 客户端兼容 | 全平台（系统内置） | 需装客户端（主流平台都有） | 需装客户端 |
| 穿透/移动 | IKEv2 支持 MOBIKE | 天生适合漫游 | 支持 |
| 典型用途 | 站点互联（设备厂商互通） | 快速建连、远程办公、内网穿透 | 需要 TCP/443 伪装 |

**简单结论**：

```
① 要跟"防火墙厂商设备"互通 → IPsec
② 自己两端都能控制、追求性能 → WireGuard
③ 网络环境只放行 443/TCP → OpenVPN（或 WireGuard over TCP 的变体）
```

### WireGuard 十分钟搭好

**服务端**：

```bash
# 生成密钥
wg genkey | tee server.key | wg pubkey > server.pub

cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = $(cat server.key)

[Peer]
PublicKey = <client.pub>
AllowedIPs = 10.8.0.2/32
EOF

systemctl enable --now wg-quick@wg0
```

**客户端**：

```ini
[Interface]
Address = 10.8.0.2/24
PrivateKey = <client.key>
DNS = 10.8.0.1

[Peer]
PublicKey = <server.pub>
Endpoint = server.example.com:51820
AllowedIPs = 10.8.0.0/24, 192.168.1.0/24
PersistentKeepalive = 25
```

**要点**：

```
① `AllowedIPs` 既是"路由"也是"ACL"（只让这些网段走隧道）
② `PersistentKeepalive` 解决 NAT 后无流量掉线
③ 要转发上网流量 → `AllowedIPs = 0.0.0.0/0` + 服务端配 NAT
```

**服务端做出口 NAT**：

```bash
echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
sysctl -p
iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE
```

### IPsec 的两种模式

```
传输模式（Transport）：只加密 payload（主机到主机）
隧道模式（Tunnel）  ：整个 IP 包加密（网关到网关）
```

**站点互联用隧道模式**。

**IKEv2 的关键参数（对不上就连不上）**：

```
① IKE 加密/哈希组（如 aes256-sha256-modp2048）
② 子网（local/remote subnet）
③ 预共享密钥或证书
④ NAT-T（有 NAT 时自动启用 UDP 4500）
```

**"两端的 Phase1/Phase2 提案不一致"是 IPsec 连不通的头号原因**。

### 五个"通了但很慢/很不稳"的原因

**① MTU 问题**

```
隧道封装增加开销 → 大包被丢
现象：ping 通、小请求正常、大文件卡住
```

**解决**：

```bash
# WireGuard 常见 MTU 1420
ip link set wg0 mtu 1420
# 或让 TCP 自己发现：确保 ICMP 不被墙
```

**"ping 通但 SSH 卡在登录"** 几乎都是 MTU。

**② AllowedIPs 写太宽/太窄**

```
太窄 → 目标网段不走隧道（访问不到）
太宽 → 与本地网络冲突（路由错乱）
```

**③ 没开转发 / 没做 NAT**

```
客户端能连上 VPN，但不能上网/不能访问对端网段
```

**④ UDP 被限速/QoS**

```
WireGuard 走 UDP，某些网络对 UDP 限速严重
→ 换端口、或用 TCP 方案
```

**⑤ 密钥/时间不同步**

```
证书过期 → 握手失败
系统时间偏差大 → IKE 失败
```

### 安全注意

```
① 密钥文件权限 600（WireGuard 会拒绝过宽权限）
② 定期轮换密钥（尤其人员流动时）
③ 最小化 AllowedIPs（不要"全打通"）
④ 启用审计日志（谁连了、连了多久）
⑤ 别把管理口暴露在 VPN 上给所有人
```

**"一个 peer 打通全部网段"** 是最常见的内网横向移动入口。

### 站点互联 vs 远程接入

```
站点互联：两端都是网关，固定公网 IP，走隧道（IPsec 更常见）
远程接入：客户端数量多、NAT 后、移动 → WireGuard/OpenVPN 更合适
```

**混合场景**：

```
分支互联用 IPsec，员工远程用 WireGuard，管理入口单独一条
```

### 检查清单

```
□ 明确场景（互联/远程/穿透）
□ 方案与场景匹配（不盲目选 IPsec）
□ MTU 已调（1420 或按隧道开销算）
□ AllowedIPs 最小化
□ 转发/NAT 已配（需要出口的场景）
□ 密钥权限 600 + 定期轮换
□ 有连接审计
□ 证书/时间同步
□ 有"连通性"监控（隧道是否在）
□ 人员离职流程包含"删除 peer"
```
