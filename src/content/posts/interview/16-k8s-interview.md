---
title: K8s 面试：从调度到网络的十道真问题
description: 十道"能问出深度"的题、答法要点，以及面试官最想听的那句话。
date: 2026-11-27
tags: [Kubernetes, 面试]
---

### 一、Pod 创建后发生了什么

```
1) kubectl → apiserver（鉴权/准入）→ etcd 写入
2) scheduler 监听到"未绑定节点"的 Pod → 选节点 → 回写 nodeName
3) kubelet 监听到"属于我且未启动"的 Pod → 拉镜像 → 调 CRI 创建容器
4) CNI 分配 IP → 挂载卷 → 启动容器
5) 探针开始工作 → Ready → Endpoint 加入
```

**关键点**：**"三个阶段都在 watch + 回写，不是 RPC 调用链"**。

### 二、Deployment 滚动更新的过程

```
① 新 ReplicaSet 创建（revision+1）
② 逐个扩新 Pod（受 maxSurge 限制）
③ 新 Pod Ready 后，缩老 Pod（受 maxUnavailable 限制）
④ 全部切换完成，老 RS 保留（用于回滚）
```

**追问**：为什么"新 Pod 没 Ready 就缩老 Pod"会中断服务？

```
API 调用会被打到未就绪的新 Pod → 报错
（readinessProbe 正确配置就是为了避免这个）
```

### 三、为什么 Pod 会被驱逐

```
① 资源压力（MemoryPressure/DiskPressure）
② 节点 NotReady
③ 污点（taint）与容忍
④ 优先级（priorityClass 抢占）
⑤ 手动 drain
```

**"驱逐 ≠ 删除"**：Pod 会被重建（在别的节点或同节点）。

### 四、Service 是怎么找到 Pod 的

```
Service → ClusterIP（虚拟 IP）
kube-proxy（iptables/ipvs）维护"ClusterIP:Port → Pod IP:Port"的转发规则
Endpoints/EndpointSlice 由 controller 从 Pod 的 Ready 状态生成
```

**"Pod 没 Ready → Endpoint 里没有它"** —— 所以探针错会导致 503。

### 五、为什么跨节点 Pod 不通

```
排查顺序：
① Pod 有没有 IP（CNI 是否就绪）
② 同节点通不通（判断是不是 CNI 本机问题）
③ 跨节点通不通（判断路由/overlay）
④ NetworkPolicy 是否拒绝
⑤ MTU（大包不通/小包通 = MTU）
```

**"ping 通但大包不通"** → 几乎一定是 MTU/overlay 封装。

### 六、HPA 为什么不扩容

```
① metrics 采不到（metrics-server 未部署/证书问题）
② 请求量没到阈值（需要看实际 vs target）
③ 已达 maxReplicas
④ 资源 request 太大，节点放不下新 Pod
⑤ 自定义指标配置错（metric name/selector）
```

```bash
kubectl get hpa -o wide
kubectl describe hpa <name>     # 看 Events 里的"unable to..."
```

### 七、etcd 磁盘满了会怎样

```
① quota（默认 2GiB）超限 → 集群变只读
② 所有写操作失败（"database space exceeded"）
③ 读还能用，但新 Pod/新配置都写不进去
```

**处理**：

```
compact + defrag + disarm alarm
长期：调 quota + 自动压缩 + 控制事件量（不要高频更新 status）
```

### 八、怎么做到"零停机发布"

```
① 探针正确（readiness 能反映真实可服务）
② 优雅退出（preStop + terminationGracePeriod）
③ 滚动策略（maxUnavailable 小、maxSurge 允许）
④ 双版本兼容（数据库迁移与代码解耦）
⑤ 流量灰度（Canary/按比例）
```

**"优雅退出"最常被忽略**：

```yaml
lifecycle:
  preStop:
    exec: {command: ["sh","-c","sleep 5"]}
terminationGracePeriodSeconds: 30
```

**"sleep 5"** 给"正在处理的请求"留出完成时间。

### 九、StatefulSet 与 Deployment 的差别

```
① 稳定网络标识（<name>-<ordinal>）
② 有序创建/删除（可以并行，但默认有序）
③ 每副本独立 PVC（volumeClaimTemplates）
④ 更新按 ordinal 逆序滚动
```

**"有状态服务必须 StatefulSet"不完全对**：

```
如果状态全在外部（DB/对象存储），无状态 Pod + Deployment 就行
```

### 十、什么时候不该用 K8s

```
① 单机小服务（运维成本 > 收益）
② 极低延迟/强实时（调度与网络开销不可接受）
③ 团队没有容器化能力（会变成灾难）
④ 只需要"定时任务"（CronJob 之外的选择更轻）
```

**"不是所有服务都要上 K8s"** 是面试官喜欢听的成熟判断。

### 面试官想听的那句话

```
"我会先确认现象、再看是哪一层，然后用最小代价验证假设"
```

**"直接给结论"** 往往是背的；**"给排查路径"** 才是真懂。

### 检查清单（自测）

```
□ 能讲清 Pod 创建的三个阶段
□ 知道 readiness 与 Endpoints 的关系
□ 会区分 HPA 不扩容的五种原因
□ 知道 etcd 满后的只读状态与处理
□ 会说"零停机"的五个前提
□ 能讲跨节点不通的排查顺序
□ 知道什么时候不该用 K8s
□ 每题都能落到"具体命令"
```
