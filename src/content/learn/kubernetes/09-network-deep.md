---
title: 第 9 章 · 网络模型深入：Pod 是怎么被"连起来"的
module: 熟练篇
summary: CNI 的职责、overlay 与 underlay、DNS 与 Service 的关系、NetworkPolicy 的生效条件。
minutes: 50
---

### 四层网络

```
① Pod 内（容器共享 pause 的 netns）
② 同节点 Pod 之间（bridge/cni0）
③ 跨节点 Pod 之间（overlay 隧道 / BGP 路由）
④ Service/Ingress（虚拟 IP 与七层入口）
```

**"Pod 通了但 Service 不通"** → 是第 ④ 层的问题，不要回头查 CNI。

### CNI 到底做什么

```
kubelet 调用 CNI 插件：
  ① 分配 IP（IPAM）
  ② 创建 veth 对，一端进 Pod netns
  ③ 配置路由与 bridge
  ④ 返回结果给 kubelet
```

**"Pod 有 IP 但 Ping 不通"** → 第 ②③ 步或上层路由有问题。

### overlay 与 underlay

| | overlay（VXLAN/IPIP） | underlay（BGP/ENI） |
| --- | --- | --- |
| 封装开销 | 有（MTU 减 50–100） | 无 |
| 依赖网络设备 | 不依赖 | 需要支持 BGP/路由 |
| 排障难度 | 多一层（隧道） | 与物理网络融合 |

**MTU 是最常见的坑**：

```
物理 1500 → VXLAN Pod 1450
小包通、大包卡 → 就是这个
```

### Service 与 DNS

```
Service → ClusterIP（虚拟）→ kube-proxy 规则 → Pod IP
CoreDNS 解析 svc.ns.svc.cluster.local → ClusterIP
```

**"能解析但连不上"** → 解析出了 IP，但 kube-proxy 规则或后端 Pod 不可用。

```bash
kubectl get endpointslices -l kubernetes.io/service-name=svc
```

### NetworkPolicy 的三个前提

```
① CNI 支持（Calico/Cilium 支持，flannel 不支持）
② 策略是"白名单叠加"
③ 只管 Pod 间流量，不管宿主机
```

**"策略写了没效果"** → 大概率 CNI 不支持或没开。

### 抓包定位（在 Pod 里）

```bash
kubectl debug -it app-0 --image=nicolaka/netshoot --target=app
tcpdump -i any -nn port 8080
```

**"两端对照抓包"** 才能判断"是没到，还是到了没回"。

### 本章检查清单

```
□ 知道四层网络各管什么
□ 知道 CNI 的四个步骤
□ 能区分 overlay/underlay 的取舍
□ 会检查 Pod MTU
□ 会看 EndpointSlice
□ 知道 NetworkPolicy 的前提
□ 会两端抓包对照
□ 有 netshoot 类镜像
```
