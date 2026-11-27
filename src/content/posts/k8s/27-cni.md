---
title: CNI 到底怎么让 Pod 通：从 veth 到 overlay
description: 三种 CNI 模式（overlay/underlay/云原生）、MTU 与路由、NetworkPolicy 生效条件,以及五个"Pod 不通"的排查顺序。
date: 2026-11-27
tags: [Kubernetes, 网络, CNI]
---

### 一个 Pod 拿到 IP 时发生了什么

```
1) kubelet 调 CRI 创建 sandbox（pause 容器）
2) 调 CNI 插件：分配 IP、创建 veth、配置路由
3) veth 一端在宿主机、一端在 pause 容器的 netns
4) 宿主机侧 bridge/路由表决定"怎么到别的节点"
```

**"Pod 有 IP 但不通"** → 问题就在第 2–4 步。

### 三种实现模式

**① Overlay（覆盖网络）**

```
Flannel(VXLAN) / Calico(IPIP 可选) / Cilium(VXLAN)
Pod 包被封装进宿主机包 → 跨节点传输
```

**优点**：与底层网络解耦（云上/混合云都能用）。
**缺点**：封装开销（MTU 减 50–100）、排障多一层。

**② Underlay（BGP 直连）**

```
Calico(BGP) / Cilium(BGP)
Pod IP 直接路由到宿主机网络，不封装
```

**优点**：性能最好（无封装）。
**缺点**：要求底层网络能"学到 Pod 网段"（交换机/路由器支持 BGP）。

**③ 云原生（ENI/IPVLAN）**

```
AWS VPC CNI / 阿里云 Terway / 腾讯云
Pod 直接拿 VPC 的 IP
```

**优点**：与云网络原生集成（安全组/NAT 直接生效）。
**缺点**：IP 数量受网卡/子网限制。

### MTU 是最常见的坑

```
物理 MTU 1500
VXLAN 封装 → 减 50 → Pod MTU 1450
IPIP → 减 20
WireGuard 再加 → 更小
```

**现象**：

```
ping 通（小包）、HTTP 小请求通、大文件/TLS 握手卡住
```

**"握手成功但传数据卡住"** → 99% 是 MTU。

```bash
# 在 Pod 里看
ip link show eth0 | grep mtu
# 测大包
ping -M do -s 1400 <target>
```

### 路由与"跨节点不通"

```
① 同节点：走 bridge/cni0（肯定通）
② 跨节点：查宿主机路由表是否有目标 Pod CIDR
③ 再查 overlay 隧道（VXLAN 端口 8472/UDP 或 IPIP 协议号 4）
```

```bash
ip route | grep 10.244
ip -d link show flannel.1        # VXLAN 设备
```

**"跨节点不通但同节点通"** → 看隧道与路由，不看应用。

### NetworkPolicy 生效条件

```
① CNI 必须实现（Calico/Cilium 支持；flannel 不支持）
② 策略是"白名单叠加"（默认拒绝 + 放行）
③ 只对"Pod 间流量"生效，不管宿主机
```

**"策略写了没效果"**：

```bash
kubectl get networkpolicy -A
kubectl describe networkpolicy <name> -n app
# 确认 CNI 是 Calico/Cilium
kubectl get pods -n kube-system | grep -E "calico|cilium"
```

### 五个"Pod 不通"的排查顺序

```
1) Pod 有 IP 吗（kubectl get pod -o wide）
2) 同节点 Pod 互通吗
3) 跨节点互通吗
4) DNS 能解析吗（nslookup kubernetes.default）
5) NetworkPolicy 是否拒绝
6) MTU 是否匹配（大包测试）
```

**"按 1→6 走"** 每一步都能定论，不用猜。

### 常用诊断（在临时容器里）

```bash
kubectl debug -it <pod> --image=nicolaka/netshoot --target=app
# 容器内
ip a; ip r
nslookup kubernetes.default
curl -sv http://<svc>.<ns>.svc.cluster.local
tcpdump -i any -nn port 80
```

### 检查清单

```
□ 明确 CNI 模式（overlay/underlay/云原生）
□ Pod MTU 与封装匹配
□ 宿主机有目标 Pod CIDR 路由
□ 隧道端口/协议未被防火墙拦
□ NetworkPolicy 由支持的 CNI 实现
□ 有"默认拒绝 + 白名单"
□ DNS（CoreDNS）正常
□ 有"同节点/跨节点"分层验证手段
□ 有 netshoot 类镜像可用
□ 排障顺序固化为 runbook
```
