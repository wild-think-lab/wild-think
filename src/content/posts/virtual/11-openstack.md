---
title: OpenStack 入门：它和"云"的关系，以及为什么难用
description: 六个核心组件、最小部署形态、与 K8s/vSphere 的定位差别，以及五个让运维头疼的现实问题。
date: 2026-11-27
tags: [OpenStack, 私有云, 虚拟化]
---

### 它是什么

```
OpenStack = 一套"自己搭 IaaS 云"的开源组件集合
对标：阿里云/腾讯云的"虚拟机 + 存储 + 网络 + 镜像"能力
```

**它与 K8s 的定位完全不同**：

```
OpenStack：造"虚拟机和云主机"（IaaS）
K8s      ：在虚拟机上跑"容器编排"（PaaS/CaaS）
```

**很多私有云的组合是"OpenStack 提供云主机 + K8s 在上面跑"**。

### 六个核心组件

| 组件 | 作用 | 一句话 |
| --- | --- | --- |
| Nova | 计算 | 管理虚拟机生命周期（创建/迁移/删除） |
| Neutron | 网络 | 虚拟网络、子网、安全组、浮动 IP |
| Cinder | 块存储 | 给虚拟机挂卷 |
| Glance | 镜像 | 存与分发镜像 |
| Keystone | 认证 | 统一认证与授权（所有组件的门） |
| Horizon | 界面 | Web 控制台 |

**辅助组件**：

```
Swift   ：对象存储
Heat    ：编排（用模板定义"一堆资源"）
Barbican：密钥管理
Ceilometer/Gnocchi：计量与监控
```

**"Keystone 是单点"**：

```
所有 API 调用都要过 Keystone
→ 它挂了 → 整个云"什么都点不动"
```

### 最小可用形态

```
1 台控制节点（Nova API/Neutron/Keystone/Glance/Horizon）
+ 1 台计算节点（Nova Compute）
+ 1 台网络节点（Neutron L3/OVS，或与计算合并）
```

**现实建议**：

```
① 学习：用 packstack/kolla-ansible 一键装（或直接用 devstack）
② 生产：kolla-ansible（容器化部署，是当前主流）
```

**"手工按文档装 OpenStack"是新手劝退第一大关**（组件依赖极多）。

### 五个让运维头疼的现实问题

**① 升级极痛**

```
组件之间版本强耦合
升一个版本可能要停云、重建部分节点
```

**② 网络最复杂**

```
Neutron 的 OVS/Linux bridge/DPDK 模式差异大
浮动 IP、安全组、VLAN/VXLAN、SR-IOV……
"网络不通"能排一整天
```

**③ 性能开销**

```
虚拟化 + overlay 网络 → 吞吐与延迟都有损耗
（这也是为什么很多场景直接上 K8s + 裸金属）
```

**④ 社区版 vs 厂商版差距大**

```
社区版：你自己承担所有问题
厂商版（华为/浪潮/新华三）：有支持但绑定
```

**⑤ 与"云原生"的编排差异**

```
OpenStack 的资源模型是"虚拟机和卷"
K8s 的模型是"Pod 与声明式"
→ 两套体系要额外做"对接层"
```

### 与 vSphere / PVE 的对比

| 维度 | OpenStack | vSphere | PVE |
| --- | --- | --- | --- |
| 定位 | IaaS 云平台 | 企业虚拟化 | 轻量虚拟化 |
| 规模 | 大（几十到上千节点） | 中大 | 小中 |
| 复杂度 | 很高 | 中 | 低 |
| 成本 | 开源（人力成本高） | 昂贵 | 免费 |
| 适合 | 需要"自助云主机"的场景 | 传统企业虚拟化 | 小团队私有云 |

**"几十台机器的场景上 OpenStack"通常是过度设计**。

### 什么时候真的需要 OpenStack

```
① 需要给多个部门"自助申请云主机"（配额/审批/计量）
② 需要"多租户隔离"（项目/配额/独立网络）
③ 规模足够大（几百台以上，人力能摊平复杂度）
④ 有明确的"私有云"定位（不是"几台虚拟机"）
```

**"只是要几台虚拟机"→ PVE 或 vSphere 更合适**。

### Heat 编排（值得了解）

```yaml
heat_template_version: 2021-04-16
resources:
  web:
    type: OS::Nova::Server
    properties:
      flavor: 2C4G
      image: ubuntu-22.04
      networks: [{ network: private }]
  fip:
    type: OS::Neutron::FloatingIP
    properties:
      floating_network: public
  assoc:
    type: OS::Neutron::FloatingIPAssociation
    properties:
      floating_ip_address: { get_res: fip }
      server_id: { get_res: web }
```

**Heat 的价值**：

```
"一堆资源"用模板描述 → 一次创建（而不是点十次界面）
```

**但它远不如 Terraform 通用**（只能管 OpenStack 内部资源）。

### 一个"少踩坑"的实践建议

```
① 用 kolla-ansible（容器化部署，升级相对可控）
② 网络先做"最简单的扁平模式"（别一上来就玩 DPDK/SR-IOV）
③ Keystone 做 HA + 独立部署
④ 控制面与计算面网络分离
⑤ 有"计量"（否则多部门用起来无法算账）
⑥ 上生产前先跑一年"内部试点"
```

### 检查清单

```
□ 先判断"是否真的需要 IaaS 云平台"
□ 知道六个核心组件与职责
□ 用 kolla-ansible 或厂商版部署
□ Keystone 做 HA（单点会全站不可用）
□ 网络先简单后复杂（不盲目上 DPDK）
□ 控制/存储/业务网络分离
□ 有配额与计量（多部门场景必备）
□ 明确"升级策略"（这是长期成本）
□ 评估"OpenStack + K8s"的对接方式
□ 规模不足时选 PVE/vSphere
```
