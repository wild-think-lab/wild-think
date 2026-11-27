---
title: Overlay 网络排障：VXLAN 场景下"跨节点不通"的四种原因
description: VXLAN 的封装原理与 MTU 代价、跨节点不通的排查顺序、tcpdump 在哪一侧抓包、flannel/calico 的路由模式差异。
date: 2026-11-27
tags: [网络, VXLAN, Overlay, Kubernetes, 排障]
---

### Overlay 的代价：多一层头

同节点内容器通信是本地转发，跨节点必须封装：

```
原始帧：[ 内层 IP 头 ][ 内层 TCP/UDP ][ 数据 ]
VXLAN 封装后：
[ 外层 IP ][ 外层 UDP ][ VXLAN 头 (8B) ][ 原始帧 ]  ← 全长多 50~60 字节
```

所以常见的 MTU 账：

| 场景 | MTU |
| --- | --- |
| 无隧道 | 1500 |
| VXLAN（IPv4） | 1450 |
| VXLAN + IPsec/WireGuard | 1370–1400 |

**MTU 不匹配的典型症状**：

- ping 通（小包），大文件传输卡住。
- SSH 登录成功但 `scp` 卡在 0%。
- HTTP 小响应正常，下载大文件超时。
- TLS 握手偶发失败。

这不是"网络不稳定"，是**大包被丢且没有正确分片**。

### 跨节点不通的四种原因（按概率排序）

**① MTU 太小 / 没下发**

```bash
ip link show | grep mtu
# 容器内看 eth0 的 MTU 是否为 1450 或更低
ping -M do -s 1400 <对端容器IP>   # 不允许分片，测真实可用 MTU
```

逐步试：`-s 1472`（=1500-28 IP+ICMP 头）通常失败，`-s 1400` 应成功。

**② 节点间 UDP 8472（flannel）或 4789（标准 VXLAN）被防火墙拦**

```bash
# 在源节点抓
tcpdump -i eth0 -nn udp port 8472 -c 20
# 在对端节点同时抓
tcpdump -i eth0 -nn udp port 8472 -c 20
```

源有、目的无 → 中间被拦（安全组/防火墙/交换机 ACL）。

**③ 路由不可达或回程缺失**

Overlay 需要"每个节点知道其他节点的 underlay IP"。检查：

```bash
ip route get <对端 underlay IP>
vtysh -c "show bgp summary"     # 若用 BGP 分发
```

云上跨 VPC 的场景最常见：**去程通了，回程没有路由**。

**④ 转发被内核关了**

```bash
sysctl net.ipv4.ip_forward      # 必须是 1
sysctl net.bridge.bridge-nf-call-iptables   # 桥接流量是否过 iptables
```

容器网络依赖 `ip_forward=1`，很多"安全加固脚本"会把它关掉，导致整个 overlay 静默失效。

### 抓包在哪一侧？

三层位置，按需求选：

```
[容器 veth] → [宿主 bridge] → [宿主 eth0 封装] → [物理网络] → [对端 eth0] → [对端 bridge] → [对端 veth]
     A              B                 C                              D            E             F
```

| 目的 | 抓哪 | 命令 |
| --- | --- | --- |
| 应用有没有发出 | A 或容器内 | `tcpdump -i eth0 -nn` |
| 封装前是否正常 | B（cni0/flannel.1） | `tcpdump -i flannel.1` |
| 封装后是否出去 | C | `tcpdump -i eth0 -nn udp port 8472` |
| 对端是否收到 | D | 同 C |
| 是否解封装成功 | E | `tcpdump -i flannel.1` |

判断口诀：**C 有、D 无 → 网络问题；D 有、E 无 → 对端内核/配置问题；E 有、F 无 → 对端 iptables。**

### Calico 与 Flannel 的路由差异

| | Flannel（VXLAN） | Calico（BGP） |
| --- | --- | --- |
| 封装 | 有，跨节点全封装 | 通常无封装（IPIP 可选） |
| MTU | 需下调 | 接近物理 MTU |
| 依赖 | UDP 端口放通 | 节点间 BGP 179 + 路由可达 |
| 排障重点 | 端口、MTU | BGP 邻居、路由表 |

Calico 不通时先看：

```bash
calicoctl node status        # BGP 邻居是否 Established
ip route | grep 10.244       # 有没有到对端 Pod 网段的路由
```

BGP 邻居 Active 状态 = 连不上（端口被拦或 IP 不通），Idle = 配置问题。

### 一个可复现的 MTU 事故

场景：K8s 集群里 pod 之间 gRPC 调用偶发超时，重试能过。

排查：

```bash
# 1. 容器内测 MTU
kubectl exec -it a -- ping -M do -s 1450 -c 3 <pod-b-ip>
# → 100% packet loss

kubectl exec -it a -- ping -M do -s 1300 -c 3 <pod-b-ip>
# → 成功
```

结论：可用 MTU 在 1300–1450 之间。再看：

```bash
kubectl exec -it a -- ip link show eth0
# mtu 1500   ← 问题在这
```

Flannel 的 `flannel.1` 是 1450，但 CNI 没把 MTU 下发到容器 veth（老版本或自定义 CNI 配置）。容器按 1500 发包，封装后超 1450 被丢。

修法：在 CNI 配置里设 `"mtu": 1450`，或让应用侧把 gRPC 的 `max_frame_size` 调小。**根治是修 CNI，应用侧改是止血。**

### 排查清单

```
① 同节点通不通？（排除 overlay，先证明 Pod 本身正常）
② 跨节点 ping 小包通不通？
③ ping -M do 逐步试 MTU
④ 两端同时抓 UDP 8472/4789
⑤ ip_forward 与 bridge-nf-call-iptables
⑥ 路由表是否有对端网段（BGP 模式看邻居状态）
⑦ iptables/ipvs 规则是否把流量丢了（kube-proxy 模式）
```

按顺序走，每一层都有明确的"通/不通"判据，不需要猜。
