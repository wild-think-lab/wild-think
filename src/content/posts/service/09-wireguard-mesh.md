---
title: WireGuard 组网：把办公室、云主机和家里连成一张网
description: WireGuard 与 IPSec/OpenVPN 的差别、密钥生成、三节点全互联配置、按需路由与 AllowedIPs、NAT 后面的机器怎么被访问、以及"能 ping 通但服务不通"的排查。
date: 2026-11-27
tags: [WireGuard, VPN, 组网, 网络]
---

### 为什么选 WireGuard

| | WireGuard | OpenVPN | IPSec |
| --- | --- | --- | --- |
| 实现 | 内核模块（Linux 5.6+） | 用户态 | 内核/用户态混杂 |
| 配置 | 一个 conf 文件 | 证书 + 配置 + 服务 | 多阶段协商，复杂 |
| 性能 | 很高（接近线速） | 中 | 高但难调 |
| 移动端切换网络 | 几乎无感 | 常断线重连 | 一般 |
| 排障 | `wg show` 一眼看清 | 日志啰嗦 | 极难 |

代价：**没有动态地址分配**，每个 peer 要固定内网 IP，配置要提前规划。

### 三个概念

- **Interface（wg0）**：本机的虚拟网卡，有一个内网地址，比如 `10.10.0.1/24`。
- **Peer**：对端。靠**公钥**识别，不看 IP。
- **AllowedIPs**：两个作用——"哪些流量走这条隧道"（路由）+"允许这个 peer 用哪些源地址"（访问控制）。

最后这条最容易误解：`AllowedIPs` 既是路由表也是 ACL。

### 生成密钥

```bash
umask 077
wg genkey | tee privatekey | wg pubkey > publickey
cat privatekey publickey
```

**私钥不要离开本机**。每台机器各生成一对。

### 场景：云主机做中心，办公室与家里接入

拓扑：

```
云主机 hub: 10.10.0.1（公网 IP 203.0.113.10:51820）
办公室 office: 10.10.0.2（在 NAT 后）
家里 home: 10.10.0.3（在 NAT 后）
```

**hub 配置** `/etc/wireguard/wg0.conf`：

```ini
[Interface]
Address = 10.10.0.1/24
ListenPort = 51820
PrivateKey = <hub 私钥>
# 让 peer 之间能互通（见下文"转发"）
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT
PostUp = iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

[Peer]
# office
PublicKey = <office 公钥>
AllowedIPs = 10.10.0.2/32, 192.168.10.0/24
PersistentKeepalive = 25

[Peer]
# home
PublicKey = <home 公钥>
AllowedIPs = 10.10.0.3/32, 192.168.20.0/24
PersistentKeepalive = 25
```

**office 配置**：

```ini
[Interface]
Address = 10.10.0.2/24
PrivateKey = <office 私钥>

[Peer]
PublicKey = <hub 公钥>
Endpoint = 203.0.113.10:51820
AllowedIPs = 10.10.0.0/24
PersistentKeepalive = 25
```

`AllowedIPs = 10.10.0.0/24` 表示"只有去 10.10.0.x 的流量走隧道"，其他照常走本地网络。想要"全部流量走 VPN"，写 `0.0.0.0/0, ::/0`。

启动：

```bash
systemctl enable --now wg-quick@wg0
wg show
```

### 关键：让 peer 之间互通

默认情况下，hub 收到 office 发往 home 的包，**不会转发**（内核 `net.ipv4.ip_forward` 没开）。两条都要做：

```bash
sysctl -w net.ipv4.ip_forward=1
echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-wg.conf
```

再加上上面的 `iptables FORWARD` 规则。

如果 office 想访问 home 的整个局域网 `192.168.20.0/24`：

- hub 上 home 的 `AllowedIPs` 要包含 `192.168.20.0/24`。
- home 上要开转发，并对内网做 SNAT：

```bash
iptables -t nat -A POSTROUTING -s 10.10.0.0/24 -o eth0 -j MASQUERADE
```

### 办公室里访问云上的服务

office 的 conf 里加上：

```ini
AllowedIPs = 10.10.0.0/24, 172.16.0.0/16
```

即"去云内网 172.16.x.x 的流量也走隧道"。云主机侧无需额外配置，因为它本来就能到 172.16 网段。

### NAT 后面的机器互相访问

两边都在 NAT 后面时，**必须有第三方做会合点**（就是上面的 hub），且 hub 要有公网 IP 或端口映射。WireGuard 本身不支持 NAT 穿透（不像 Tailscale 有打洞）。

这就是 Tailscale/ZeroTier 的价值：在 WireGuard 之上做了打洞与中继。自建时接受"hub 中转"就行，代价是带宽走 hub。

### "能 ping 通但服务不通"

按这个顺序查：

```bash
wg show                              # 有没有 latest handshake、transfer 是否增长
ping -c 3 10.10.0.3                  # 隧道层通不通
ss -lntp                             # 目标端口有没有在听
curl -v --connect-timeout 3 http://10.10.0.3:8080/
iptables -L FORWARD -n -v            # 转发链有没有被 drop
```

常见原因：

1. **AllowedIPs 没写对**：对方返回的包源地址不在你的 AllowedIPs 里，会被丢。
2. **MTU 问题**：隧道头占用额外字节，默认 1420，遇到 PPPoE（1492）或双层隧道会需要降到 1280–1380。症状是"小包通、大包卡死"（SSH 能连但传文件卡）。
3. **防火墙只放了 UDP 51820 入向，没放转发**。
4. **`PersistentKeepalive` 没配**：NAT 后端的机器长时间空闲后映射失效。
5. **客户端 DNS 没走隧道**：如果访问的是域名且内网 DNS 在隧道里，要配 `DNS = 10.10.0.1`（需要 `resolvconf`）。

MTU 测试：

```bash
ping -M do -s 1400 10.10.0.3        # 逐步降低，找到不分片的最大值 + 28 = 安全 MTU
```

### 安全注意

- 每个 peer 用独立密钥，不要共用。
- 私钥文件权限 `600`，`umask 077` 再生成。
- `AllowedIPs` 尽量精确到 `/32` 与必要网段，别图省事写 `0.0.0.0/0` 双向全开。
- 定期轮换密钥（删 peer 时同时删对端配置）。

### 一句话总结

WireGuard 的配置只有"地址、公钥、AllowedIPs"三样，难点全在**转发、路由与 MTU**。把这三件事理清，一张跨三地的网 20 分钟就能通。
