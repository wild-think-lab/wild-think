---
title: 观测与容量：让集群"看得见、算得清"
module: 进阶篇
summary: 三层观测（节点/工作负载/业务）、容量估算的四个输入、资源碎片与 request 超卖的代价，以及一次容量评审怎么开。
minutes: 20
---

### 三层观测

```
① 节点层：CPU/内存/磁盘/网络（USE）
② 工作负载层：Pod 的重启数、资源用量、就绪状态
③ 业务层：QPS、错误率、延迟、饱和度
```

**"只看节点层"会漏掉两类问题**：

```
① Pod 反复重启（节点看起来正常）
② 业务慢了但资源没满（瓶颈在下游）
```

### 工作负载层必看指标

```
kube_pod_container_status_restarts_total   重启次数
kube_pod_status_ready                      是否就绪
container_memory_working_set_bytes         实际内存
container_cpu_usage_seconds_total          CPU 用量
kube_pod_container_status_last_terminated_reason  退出原因
```

**"重启次数"是最有价值的信号**：

```
持续增长 → OOMKilled / 探针失败 / 崩溃循环
```

**排查重启原因**：

```bash
kubectl describe pod api-xxx | grep -A5 "Last State"
# 看 Reason: OOMKilled / Error / Completed
```

### 容量估算的四个输入

```
① 单请求的资源成本（CPU 时间、内存）
② 目标 QPS（峰值）
③ 单实例能承载的 QPS（压测得出）
④ 冗余系数（N+1 或 1.3 倍）
```

**计算**：

```
所需副本 = ceil(峰值 QPS / 单实例 QPS) × 冗余
所需 CPU = 所需副本 × 每副本 CPU request
```

**"拍脑袋定副本数"是最常见的容量问题**：

```
3 个副本扛 500 QPS 还是 5000 QPS？没人知道 → 压测
```

### 资源碎片与超卖

**碎片**：

```
节点 8 核，剩余 1.5 核 → 一个 request 2 核的 Pod 调度不上去
→ 节点明明"没满"却调度失败
```

**超卖**：

```
节点 8 核，Pod request 总和 12 核
→ 全部调度成功，但实际争抢 CPU → 全部变慢
```

**判断方法**：

```bash
kubectl describe node <node> | grep -A10 "Allocated resources"
# 对比 Requests 与 Limits 与 Capacity
```

**"节点 CPU 使用率不高但服务很慢"** → 可能是 request 超卖导致争抢。

### 一个"容量评审"怎么开

```
① 服务清单：每个服务的 QPS 目标、延迟目标
② 资源账本：每个服务的 request/limit × 副本
③ 节点账本：每节点的可分配资源（扣除系统组件）
④ 峰值演练：模拟峰值，看是否有节点超卖
⑤ 缺口清单：哪些服务"没地方放"，怎么扩
```

**"资源账本"要有表**，而不是口头说"应该够"。

### 磁盘与镜像的容量

```
① 节点本地盘：镜像 + 容器日志 + emptyDir
② 镜像仓库：每个 tag 都占空间（清理策略）
③ 日志：容器日志默认无限增长（要配 rotation）
```

**"节点磁盘满"的三个常见原因**：

```
① 容器日志没轮转（/var/log/containers）
② 镜像堆积（旧 tag 没清理）
③ emptyDir 写满（临时文件没清理）
```

**配日志轮转**：

```yaml
# containerd 配置
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  ...
[plugins."io.containerd.grpc.v1.cri"]
  max_container_log_line_size = 16384
```

**或用 K8s 的 `--container-log-max-size`（kubelet 参数）**。

### 扩展的三条路

```
① 加副本（HPA）：受下游约束
② 加节点（Cluster Autoscaler）：有 5–15 分钟延迟
③ 加规格（换更大的机器）：一次性，不可持续
```

**"先扩副本，再扩节点，最后才考虑换规格"**。

### 一个"容量预警"的看板

```
① 节点 CPU/内存的"可分配余量"（不是使用率）
② 每服务的副本数趋势（是否顶到 maxReplicas）
③ 磁盘水位（85%/90%/95% 三档）
④ HPA 的"扩容次数"（频繁扩缩说明阈值或容量有问题）
```

**"HPA 反复扩缩"是容量不足的信号**：

```
扩容 → 压力下降 → 缩容 → 压力上升 → 扩容
→ 说明"单实例能力不够"或"缩容太快"
```

### 检查清单

```
□ 三层观测都有（节点/工作负载/业务）
□ 监控 Pod 重启数与退出原因
□ 容量按"压测 + 冗余系数"算
□ 会看节点 Allocated resources（防超卖）
□ 有资源账本（服务 × 副本 × request）
□ 峰值演练过
□ 容器日志有轮转
□ 镜像有清理策略
□ 磁盘水位三档告警
□ 扩副本 → 扩节点 → 换规格的顺序
□ 监控 HPA 扩缩频率
```
