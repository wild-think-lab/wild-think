---
title: K8s 存储：PV、PVC 与 StatefulSet 到底怎么用
description: 三种访问模式、绑定与回收策略、StatefulSet 的卷模板、以及五个"数据消失"的真实原因。
date: 2026-02-02
tags: [Kubernetes, 存储, 有状态]
---

### 三个对象的层次

```
StorageClass：我能提供什么类型的存储（动态供给的模板）
PV          ：一块具体的存储（由管理员创建或被动态创建）
PVC         ："我要一块 XX 大小、XX 访问模式"的申请
```

**"Pod 直接用 PVC，PVC 绑定 PV"**：

```
Pod → PVC（申请）→ PV（实体）→ 后端（NFS/Ceph/云盘）
```

### 三种访问模式

```
ReadWriteOnce（RWO）：单节点读写（最常见）
ReadOnlyMany（ROX） ：多节点只读
ReadWriteMany（RWX）：多节点读写（需要 NFS/CephFS 等）
```

**关键坑：RWO 不等于"单 Pod"**：

```
RWO 是"单节点"，同一节点上的多个 Pod 可以同时挂载
→ 以为 RWO 能防并发写，是误解
```

**"多个 Pod 写同一个磁盘导致数据损坏，是预期行为"**：

```
K8s 不提供文件级锁
需要 RWX 且有集群文件系统，或干脆"一个 Pod 一个卷"
```

### 动态供给

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast
provisioner: csi.example.com
parameters:
  type: ssd
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

**两个重要字段**：

```
reclaimPolicy      ：Delete（删除 PVC 就删卷）/ Retain（保留，手动清理）
volumeBindingMode  ：Immediate（立即绑定）/ WaitForFirstConsumer（等 Pod 调度后再绑）
```

**`WaitForFirstConsumer` 很重要**：

```
本地盘/拓扑受限的存储，立即绑定可能绑到"Pod 用不了的节点"
→ 用 WaitForFirstConsumer 让调度和绑定一起做
```

### PVC 的最小写法

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  storageClassName: fast
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 20Gi
```

**`storage` 是"最小保证"，不一定等于实际可用**（有些后端会向上取整）。

### StatefulSet 与 volumeClaimTemplates

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
spec:
  serviceName: mysql
  replicas: 3
  selector:
    matchLabels: { app: mysql }
  template:
    metadata:
      labels: { app: mysql }
    spec:
      containers:
      - name: mysql
        image: mysql:8.0
        volumeMounts:
        - name: data
          mountPath: /var/lib/mysql
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast
      resources:
        requests: { storage: 50Gi }
```

**StatefulSet 的三个特性**：

```
① 稳定的名字（mysql-0/1/2）与 DNS
② 稳定的存储（每个副本一个独立 PVC）
③ 有序的创建/删除
```

**注意"删除 StatefulSet 不会删 PVC"**（这是保护，也是"存储泄漏"的来源）。

### 五个"数据消失"的真实原因

**① reclaimPolicy: Delete + 删了 PVC**

```
① 误删 PVC → 后端卷被删 → 数据没了
② 用 Retain 能避免（但要手动清理旧卷）
```

**"生产的关键数据应该用 Retain"**。

**② emptyDir 当成持久存储**

```yaml
volumes:
- name: data
  emptyDir: {}      # Pod 删除 → 数据消失
```

**`emptyDir` 只在 Pod 生命周期内有效**。

**③ hostPath 的隐患**

```yaml
- hostPath:
    path: /data/mysql
```

**问题**：

```
① Pod 换节点 → 数据在旧节点（看不到）
② 多租户共享宿主机目录 → 越权/损坏
```

**hostPath 只适合"必须在宿主机上"的场景**（如日志采集）。

**④ 卷扩容没做**

```yaml
allowVolumeExpansion: true
```

**扩容 PVC 后要确认文件系统也扩了**：

```bash
# 有些 CSI 需要 Pod 重启才生效
kubectl exec pod -- df -h /data
```

**⑤ 备份没做**

```
PV 只是"存储"，不是"备份"
→ 卷损坏/误删/被加密，都需要独立备份
```

**"有 PVC 就等于有数据保障"是最大的误解**。

### 常见排查

```bash
# PVC 状态
kubectl get pvc
# Pending → 无法绑定（没有匹配 PV 或无 StorageClass）

# 为什么 Pending
kubectl describe pvc data
# 看 Events："no persistent volumes available" / "waiting for pod"

# 卷详情
kubectl get pv
kubectl describe pv <name>

# Pod 挂载失败
kubectl describe pod mysql-0 | grep -A10 Events
```

**"PVC Pending 的三种原因"**：

```
① 没有 StorageClass（静态供给又没配 PV）
② 没有匹配的 PV（大小/访问模式不符）
③ 后端供给失败（CSI 插件异常/配额）
```

### CSI 是什么

```
Container Storage Interface：K8s 与存储系统的标准接口
→ 各厂商提供 CSI 驱动，K8s 不需要认识具体存储
```

**排查 CSI 问题**：

```bash
kubectl get pods -n kube-system | grep csi
kubectl logs -n kube-system <csi-controller-pod>
```

**"卷挂载卡住"多半在 CSI 的 attach/mount 阶段**。

### 一个有状态服务的完整清单

```
① StatefulSet + Headless Service（稳定 DNS）
② volumeClaimTemplates（每副本独立卷）
③ 存储用 Retain（防误删）
④ 有独立备份（不依赖 PV）
⑤ 资源 limit 与 request（有状态服务更敏感）
⑥ 有 readiness（数据目录初始化完成才 Ready）
⑦ 单实例写入（或明确的分片方案）
```

**"MySQL 多副本同时写同一卷"是数据损坏的经典场景**。

### 检查清单

```
□ 分清 StorageClass/PV/PVC
□ RWO 不等于单 Pod（别指望它防并发写）
□ WaitForFirstConsumer（拓扑受限场景必配）
□ 关键数据用 reclaimPolicy: Retain
□ 不用 emptyDir 存重要数据
□ hostPath 只用于必要场景
□ 扩容后确认文件系统已扩
□ PV 之外有独立备份
□ 会看 PVC 的 Events 排 Pending
□ CSI 插件异常时看 controller 日志
□ 有状态服务有 Headless Service
```
