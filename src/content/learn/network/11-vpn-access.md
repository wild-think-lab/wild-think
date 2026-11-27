---
title: 远程接入：WireGuard 与 OpenVPN
module: 熟练篇
summary: WireGuard 的密钥与路由配置、OpenVPN 的证书体系、两条链路的取舍，五个"连上了但访问不了"的原因。
minutes: 45
---

### 两种方案的性格

| 维度 | WireGuard | OpenVPN |
| --- | --- | --- |
| 实现 | 内核态，极简 | 用户态，成熟 |
| 配置 | 一个配置文件 | 证书 + 服务端配置 |
| 性能 | 高（吞吐好） | 中 |
| 生态 | 新，客户端少些 | 老，几乎全平台 |
| 认证 | 公钥 | 证书 + 可选账号 |

**判据**：点对点/内网互联选 WireGuard；需要和企业 CA/审计深度集成选 OpenVPN。

### WireGuard 服务端

```bash
dnf install -y wireguard-tools
wg genkey | tee server.key | wg pubkey > server.pub
```

```conf
# /etc/wireguard/wg0.conf
[Interface]
Address = 10.10.0.1/24
ListenPort = 51820
PrivateKey = <server.key 内容>

[Peer]
PublicKey = <client.pub>
AllowedIPs = 10.10.0.2/32
```

```bash
sysctl -w net.ipv4.ip_forward=1
firewall-cmd --add-port=51820/udp --permanent
systemctl enable --now wg-quick@wg0
wg show
```

### WireGuard 客户端

```conf
[Interface]
Address = 10.10.0.2/24
PrivateKey = <client.key>

[Peer]
PublicKey = <server.pub>
Endpoint = vpn.example.com:51820
AllowedIPs = 10.10.0.0/24, 10.0.0.0/16
PersistentKeepalive = 25
```

**`AllowedIPs` 是双向的**：既是"允许哪些流量进来"，也决定"哪些流量走隧道"。

### OpenVPN（证书体系）

```bash
# 用 easy-rsa 建 CA 与证书
make-cadir /etc/openvpn/easy-rsa && cd /etc/openvpn/easy-rsa
./easyrsa init-pki
./easyrsa build-ca
./easyrsa gen-req server nopass
./easyrsa sign-req server server
./easyrsa gen-dh
openvpn --genkey secret ta.key
```

```conf
# server.conf 关键项
port 1194
proto udp
dev tun
ca ca.crt
cert server.crt
key server.key
dh dh.pem
tls-auth ta.key 0
server 10.20.0.0 255.255.255.0
push "route 10.0.0.0 255.255.0.0"
keepalive 10 60
```

**要点**：`tls-auth`（或 tls-crypt）能挡掉扫描与无效握手。

### 五个"连上了但访问不了"

**① 没开转发**

```
sysctl net.ipv4.ip_forward=0 → 只能连 VPN 服务器本身
```

**② 没有 NAT 或回程路由**

```
内网设备不知道 10.10.0.0/24 怎么回
→ 在服务端做 MASQUERADE，或在核心路由加静态路由
```

**③ 防火墙没放行 tun 接口**

```bash
firewall-cmd --add-interface=tun0 --zone=trusted
```

**④ AllowedIPs 没包含目标网段**

```
只写了 10.10.0.2/32 → 只能访问服务端
```

**⑤ MTU 问题**

```
大包不通（页面打不开但 ping 正常）→ 调 MTU 1280-1420
```

### 安全注意

```
① 私钥权限 600
② 一人一密钥（可吊销）
③ 服务端日志留连接记录
④ 不做全局代理（除非必要，防数据外流）
⑤ 定期轮换密钥
```

### 检查清单

```
□ 密钥/证书权限 600
□ 一人一密钥，可吊销
□ ip_forward 已开
□ 有 NAT 或回程路由
□ 防火墙放行 tun/wg 接口
□ AllowedIPs/push route 覆盖目标网段
□ MTU 已调（弱网验证）
□ 有连接日志
□ 有客户端配置发放流程
□ 有失效密钥回收
```
