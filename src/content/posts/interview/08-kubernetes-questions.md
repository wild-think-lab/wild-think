---
title: Kubernetes 面试题：从"会用"到"能答到点上"
description: 20 道高频题的答案骨架，每道都给出"面试官在听什么"，以及那些一句话就能暴露经验的追问。
date: 2026-11-27
tags: [面试, Kubernetes, 求职]
---

### 怎么用这篇

每题给三段：**问题**、**答题骨架**、**面试官在听什么**。别背原句，记住骨架里的因果链。

### 一、调度与资源

**Q1：一个 Pod 一直 Pending，你怎么查？**

骨架：`describe` 看 Events → 按事件分类 → 四类原因（资源不足 / 亲和性不满足 / 污点 / 未绑定 PVC）。

```bash
kubectl describe pod <p> | tail -15
kubectl get nodes -o wide
kubectl describe node <n> | grep -A5 Allocated
```

听什么：**能不能从 Events 直接说出原因类别**，而不是"重启试试"。

**Q2：requests 和 limits 的区别，超了会怎样？**

骨架：requests 决定调度（预留资源），limits 是运行期上限。CPU 超 limits 被限流（throttle），内存超 limits 被 OOM Kill（137）。

听什么：**CPU 限流 vs 内存被杀**，这两者行为完全不同，是区分"背过"和"懂"的分界线。

**Q3：QoS 三个等级与驱逐顺序？**

骨架：Guaranteed（requests=limits）> Burstable > BestEffort；节点压力时按 BestEffort → Burstable 顺序驱逐。

### 二、网络

**Q4：Service 是怎么找到 Pod 的？**

骨架：Service 有 ClusterIP + selector → Endpoints 控制器把 Ready 的 Pod IP 写进 Endpoints → kube-proxy 用 iptables/IPVS 做转发；DNS 由 CoreDNS 解析 `svc.ns.svc.cluster.local`。

追问：**Endpoints 为空怎么查**？→ selector 不匹配 / Pod 未 Ready / targetPort 名称不一致。

**Q5：ClusterIP、NodePort、LoadBalancer 的区别？**

骨架：仅集群内 / 每节点开端口 / 由云厂商分配外部 IP。三者本质都是"从 Service 到 Pod 的转发"，区别在入口在哪一层。

**Q6：Pod 跨节点通信怎么走？**

骨架：CNI 插件决定。Flannel VXLAN 是封装（多 50 字节，MTU 需下调）；Calico 是路由（BGP 分发 Pod 网段，通常无封装）。

追问：**MTU 不匹配会怎样**？→ 小包通大包丢，表现为"ping 通但下载卡住"。

### 三、存储

**Q7：PV、PVC、StorageClass 的关系？**

骨架：PV 是"实际存储"，PVC 是"申请"，StorageClass 决定"怎么动态供给"。绑定看容量、访问模式、选择器。

**Q8：StatefulSet 与 Deployment 的差别？**

骨架：稳定网络标识（`pod-0` 而非随机名）、稳定存储（volumeClaimTemplates）、有序启停（保证主从顺序）。

**Q9：数据丢了怎么恢复？**

骨架：分场景。Pod 内数据 → 卷与备份；PV 数据 → 存储侧快照/备份；配置 → Git。强调"备份必须演练过"。

### 四、发布与运维

**Q10：滚动更新怎么保证不出错？**

骨架：maxSurge/maxUnavailable 控制节奏 + readinessProbe 保证"真就绪"才接流量 + PDB 保证中断时有副本 + 探针的 initialDelay 要覆盖启动时间。

追问：**探针配太激进会怎样**？→ Pod 反复重启，滚动更新卡住。

**Q11：怎么回滚？**

骨架：`kubectl rollout undo` 回上一版；镜像 tag 用 commit sha 才能精确回滚；配置用 Git 回滚 + 重新 apply。

**Q12：一次发布后 502 激增，怎么排？**

骨架：Ingress → Endpoints → Pod Ready → 端口/协议 → 探针与超时。按层收敛，不猜。

**Q13：节点要维护，怎么做不影响业务？**

骨架：`drain`（先驱逐，尊重 PDB）→ 维护 → `uncordon` → 验证调度恢复。有状态服务需先确认数据副本健康。

### 五、控制面与原理

**Q14：从 `kubectl apply` 到一个 Pod 跑起来，中间发生了什么？**

骨架：kubectl → apiserver（认证/鉴权/准入）→ etcd 写入 → controller-manager（Deployment→ReplicaSet→Pod）→ scheduler 选节点（写 `nodeName`）→ kubelet 收到 → CRI 拉镜像建容器 → CNI 配网络 → CSI 挂卷 → 状态回写。

听什么：**顺序与组件职责**。答不出"谁写 nodeName"通常说明只看过教程。

**Q15：etcd 挂了会怎样？**

骨架：控制面只读失效（无法读写对象），但**已运行的 Pod 继续跑**（kubelet 与容器不受影响）。恢复 etcd 后集群回到最后一致状态。

追问：**为什么已运行的 Pod 不受影响**？→ 因为运行态由 kubelet 与容器运行时维持，不依赖 apiserver。

**Q16：为什么 kubelet 用 list-watch 而不是轮询？**

骨架：减少 apiserver 压力、降低延迟；用 resourceVersion 做增量同步，配合本地缓存。

### 六、排障实战

**Q17：Pod CrashLoopBackOff 怎么查？**

骨架：`logs --previous` 看上次退出原因 → `describe` 看 exit code（137=OOM/被杀，1=应用错误，143=SIGTERM）→ 检查探针与启动脚本 → 检查 ConfigMap/Secret 挂载。

**Q18：节点 NotReady 怎么查？**

骨架：`journalctl -u kubelet` → 三类原因：容器运行时不通、CNI 未就绪、磁盘/内存压力（DiskPressure）。

**Q19：集群里某个 namespace 的 Pod 全部起不来，但其他正常？**

骨架：差别在 namespace 级资源：ResourceQuota、LimitRange、NetworkPolicy、ServiceAccount 与 RBAC。逐个排除。

**Q20：怎么排查"偶发超时"？**

骨架：三层证据链——指标（P99 与时间分布）、链路追踪（哪一段 span 慢）、系统层（runqlat/biolatency/tcpretrans）。强调**先定位"哪一段"，再猜"为什么"**。

### 收尾怎么答

面试最后常问"你做过最有价值的运维改进是什么"。答案结构：

```
现象（具体指标）→ 根因（不是"配置错了"而是"为什么当时这么配"）→ 改动（可量化）→ 验证（前后对比）→ 沉淀（文档/告警/流程）
```

不做"现象 → 修好"的流水账。**能说清"为什么当时会这么设计、后来为什么不够用"，比说清"改了什么"更有分量。**
