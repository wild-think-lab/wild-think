---
title: 嵌套虚拟化：在虚拟机里跑 K8s 实验集群
description: 三种宿主的开启方式（VMware/Hyper-V/KVM）、性能损耗的真实数字、网络怎么通、以及"开了嵌套但 VM 起不来"的四种原因。
date: 2026-11-27
tags: [虚拟化, 嵌套虚拟化, K8s, 实验]
---

### 什么场景需要嵌套虚拟化

```
① 只有一台物理机，想在里面跑多节点 K8s（K8s 节点本身是 VM）
② 云上服务器（本身就是 VM）里跑虚拟化
③ 测试 PVE/ESXi 等虚拟化平台
```

**本质**：让"虚拟机"具有 VT-x/AMD-V 能力，从而能在里面再开虚拟机。

### 三种宿主的开启

**① VMware Workstation/ESXi**

```
虚拟机设置 → 处理器 → 勾选 "虚拟化 Intel VT-x/EPT 或 AMD-V/RVI"
（VM 必须关机状态才能改）
```

对应 VMX 配置：

```
vhv.enable = TRUE
```

**② Hyper-V**

```powershell
# 宿主机（Hyper-V 主机本身）
Set-VMProcessor -VMName node1 -ExposeVirtualizationExtensions $true
# 嵌套 VM 要关闭动态内存（否则嵌套会失败）
Set-VM -VMName node1 -DynamicMemory $false
```

**③ KVM/libvirt**

```xml
<cpu mode='host-passthrough' check='none'>
  <feature policy='require' name='vmx'/>
</cpu>
```

`host-passthrough` 是关键：`host-model` 经常不带 vmx/svm。

```bash
# 验证
egrep -c '(vmx|svm)' /proc/cpuinfo     # 宿主机
# 嵌套 VM 内
grep -o 'vmx\|svm' /proc/cpuinfo | head -1
```

**④ 云服务器**

阿里云/腾讯云的"嵌套虚拟化"需要：

- 实例规格支持（部分共享型不支持）。
- 在控制台开启"嵌套虚拟化"选项（有的产品叫"启用虚拟化"）。
- 部分云厂商完全不允许。

### 性能损耗的真实数字

| 层级 | 大致损耗 |
| --- | --- |
| 物理机 → 第一层 VM | 3–8% |
| 第一层 → 第二层 VM（嵌套） | 再叠加 10–30% |

**实际感受**：

```
3 个嵌套 K8s 节点（各 2C4G）在 8C32G 物理机上：
- 单节点起得来，kubeadm init 可以完成
- 同时跑 etcd + apiserver + kubelet + CNI，CPU 会有明显争抢
- 复杂 CNI（Calico BGP）在嵌套里偶发不稳
```

**建议**：做"流程与配置"的学习用嵌套；做"性能与稳定性"实验用真机或云上多台。

### 网络怎么通

嵌套带来的网络层次：

```
物理网络 → 第一层 VM 的网卡 → 第二层 VM 的虚拟网桥
```

三种可行方案：

**① 全 NAT（最简单）**

```
物理机 NAT 给第一层 VM（10.10.0.x）
第一层 VM 内用 libvirt 默认 NAT（192.168.122.x）给第二层
第二层能上网，但外部访问需要两级端口转发
```

缺点：K8s 的 NodePort/LoadBalancer 从外部访问很麻烦。

**② 桥接到第一层的网卡（推荐）**

```bash
# 在第一层 VM 里
ip link add br0 type bridge
ip link set eth0 master br0
ip addr add 10.10.0.11/24 dev br0    # 把 eth0 的 IP 移到 br0
ip link set br0 up
# 第二层 VM 的网卡桥到 br0 → 直接拿到 10.10.0.x
```

前提：第一层 VM 的网卡要允许混杂模式（VMware 里要设 `promiscuous`）。

**③ 用 macvlan**

```bash
ip link add macv0 link eth0 type macvlan mode bridge
```

适合单机多 IP，但跨节点通信需要网络设备支持。

### "开了嵌套但 VM 起不来"的四种原因

| 现象 | 原因 |
| --- | --- |
| `VT-x is not available (vmx)` 报错 | 宿主没开嵌套；或第一层 VM 用 host-model CPU |
| 起得来但极慢 | 动态内存/内存气球；CPU 过度超卖 |
| 第二层 VM 网络不通 | 第一层没开混杂模式；网桥没起 |
| 嵌套 VM 随机卡死 | 时间漂移 + 缺少 CPU 特性 |

**最常见的**是第一种：配置了嵌套，但 VM 的 CPU 类型是 `host-model` 而不是 `host-passthrough`。

### 一个可行的实验配置（8C32G 物理机）

```
第一层（VMware，4C16G，磁盘 NVMe 100G）
  └─ 里面装 Ubuntu 22.04 + KVM
       ├─ k8s-master   2C4G
       ├─ k8s-worker1  2C4G
       └─ k8s-worker2  2C4G
```

kubeadm 注意事项：

```bash
# 关闭 swap
swapoff -a; sed -i '/swap/s/^/#/' /etc/fstab
# 加载模块
modprobe br_netfilter; modprobe overlay
# sysctl
cat >/etc/sysctl.d/k8s.conf <<EOF
net.bridge.bridge-nf-call-iptables=1
net.ipv4.ip_forward=1
EOF
sysctl --system
```

**CNI 选择**：嵌套环境首选 **Flannel（VXLAN）** 或 **Calico（IPIP 模式）**；BGP 模式在嵌套里容易因网络层次问题不稳。

### 检查清单

```
□ 物理机 BIOS 开了 VT-x/AMD-V
□ 第一层 VM 的 CPU 类型是 host-passthrough（不是 host-model）
□ 第一层 VM 关闭动态内存（Hyper-V）
□ 网卡允许混杂模式（桥接场景）
□ 磁盘用 NVMe/SSD（etcd 对 IO 敏感）
□ 理解性能叠加损耗，重负载实验别用嵌套
□ CNI 选简单模式（VXLAN/IPIP，不用 BGP）
```
