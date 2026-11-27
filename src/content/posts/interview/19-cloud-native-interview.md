---
title: 云原生面试：从"用过"到"设计过"
description: 十道高频题的及格线/加分项，覆盖调度、网络、存储、发布、容量与排障。
date: 2025-05-25
tags: [面试, 云原生, K8s]
---

### 一、Pod 和容器有什么区别

**及格**：

```
Pod 是最小调度单位，里面共享网络与存储卷
```

**加分**：

```
① 同 Pod 容器共享 network namespace（同 IP）
② 共享卷（emptyDir）
③ Pod 是"原子调度"，同 Pod 一定在同一节点
④ 生命周期一致（一起创建/一起销毁）
```

**"回答得像背定义"** 会被追问"为什么要共享网络"。

### 二、Deployment 滚动更新怎么做到不中断

```
① maxUnavailable: 0 + maxSurge
② readiness 探针真实可用
③ preStop + 优雅退出（摘流量有延迟）
④ 接口/数据向前兼容
⑤ PDB 保护容量
```

**"只答滚动策略"** 会被追问"新旧版本怎么共存"。

### 三、Pod 一直 Pending 怎么查

```
① describe pod 看 Events（最先看这个）
② 资源不足（request 太大）
③ 亲和性/污点不满足
④ 存储卷挂不上
⑤ 镜像拉不下来（ImagePullBackOff 是另一个状态）
```

### 四、Service 是怎么工作的

```
① 每个节点有 kube-proxy（iptables 或 IPVS）
② ClusterIP 是虚拟 IP，通过规则 DNAT 到 Pod IP
③ Endpoints/EndpointSlice 记录可用 Pod
④ 无头 Service（headless）用于 StatefulSet 的 DNS 解析
```

**"只答 'Service 就是个负载均衡'"** 不够。

### 五、跨节点网络怎么通

```
① overlay（VXLAN 封装）或 underlay（BGP 路由）
② 宿主机路由表要知道目标 Pod CIDR
③ MTU 要按封装调整（VXLAN 1450）
```

**"能说清 veth + 路由 + 封装"** 是加分项。

### 六、PVC 挂不上怎么查

```
① describe pvc 看 Events
② StorageClass 是否匹配
③ CSI 插件是否运行
④ accessMode（RWO/RWX）
⑤ 后端容量/权限
```

### 七、怎么做容量规划

```
① request 总和（不是使用率）
② 峰值 × 冗余（N+1）
③ 有状态服务的卷可用性
④ 压测找瓶颈
```

**"只说 '看监控加机器'"** 会被追问判据。

### 八、升级集群要注意什么

```
① 不跨小版本
② 控制面先，kubelet 后
③ 弃用 API 先处理（kubent）
④ etcd 快照
⑤ 逐台 drain + PDB
```

### 九、怎么保证集群安全

```
① RBAC 最小化（不用 cluster-admin）
② Pod：非 root / 只读根 / drop caps / PSA
③ 网络：默认拒绝 NetworkPolicy
④ 供应链：白名单仓库 + 验签
⑤ 审计日志 + 告警
```

### 十、一次线上故障你怎么处理

```
① 先止损（回滚/切流/降级）
② 保留现场（日志/指标/快照）
③ 分层定位（同层对比、二分）
④ 复盘落到整改项
```

**"先查根因再止损"** 在面试里是减分（生产实践相反）。

### 面试官在听什么

```
① 有没有"分层"的思维模型
② 每句话能不能落到命令/配置
③ 知不知道"为什么不那样做"
④ 有没有"从设计角度"的取舍
```

### 检查清单（自测）

```
□ 十道题都能给"命令级"答案
□ 能说清"共享网络/卷"的原因
□ 能说清"零中断发布"的全部前提
□ 能说清"三层网络路径"
□ 能说清"安全四层边界"
□ 能说"为什么不用 cluster-admin"
□ 能说"为什么不跨版本升级"
□ 能说"为什么 N+1"
□ 有真实故障案例可讲
□ 回答里带判据（不是形容词）
```
