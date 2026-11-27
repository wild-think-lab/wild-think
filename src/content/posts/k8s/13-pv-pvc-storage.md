---
title: PV、PVC 与 StorageClass：K8s 存储到底怎么配
description: 三者的关系、三种供给模式、访问模式的实际含义、扩容与回收策略，以及"PVC 一直 Pending"的六种原因。
date: 2024-10-27
tags: [Kubernetes, 存储, PV, PVC]
---

### 三者的关系

```
StorageClass（怎么造卷）
    ↓ 动态供给
PV（一块真实的卷）
    ↓ 绑定
PVC（用户的申请单）
    ↓ 挂载
Pod
```

一句话：**PVC 是"我要 10G 存储"的申请，PV 是"给你这块卷"，StorageClass 是"谁能造卷"**。

### 三种供给模式

| 模式 | 说明 | 场景 |
| --- | --- | --- |
| 静态供给 | 管理员先建 PV，PVC 来匹配 | 已有存储，或特殊卷 |
| 动态供给 | StorageClass + provisioner 自动创建 | 主流做法 |
| 外部供给（External） | NFS/Ceph CSI 插件提供 | 自建存储 |

动态供给示例：

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast
provisioner: csi-driver.example.com
parameters:
  type: ssd
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

### `volumeBindingMode` 的关键差异

| 值 | 行为 | 影响 |
| --- | --- | --- |
| `Immediate` | PVC 一创建就分配卷 | 可能分配到"Pod 调度不到的节点" |
| `WaitForFirstConsumer` | 等 Pod 调度后再分配 | **推荐**（卷和 Pod 在同一节点/区域） |

**这是"PVC Bound 但 Pod 起不来"的常见原因**：`Immediate` 模式下卷在一个节点，Pod 被调度到另一个节点，而访问模式是 `RWO` 无法跨节点挂载。

### 访问模式的真实含义

| 模式 | 含义 | 常见支持 |
| --- | --- | --- |
| `RWO` | 单节点读写（同节点多 Pod 可以） | 几乎所有块存储 |
| `ROX` | 多节点只读 | NFS、CephFS |
| `RWX` | 多节点读写 | NFS、CephFS、部分 NAS |
| `RWOP` | 单 Pod 读写 | 少数 CSI |

**最大的误解**：`RWO` 不是"单 Pod"，是"单节点"。同一节点上的多个 Pod 可以共享同一 RWO 卷。

需要"多个 Pod 在不同节点同时读写" → 必须 `RWX`（NFS/CephFS/对象存储）。

### 常见 PVC 写法

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
  namespace: prod
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: fast
  resources:
    requests:
      storage: 20Gi
```

挂载：

```yaml
spec:
  containers:
  - name: app
    volumeMounts:
    - name: data
      mountPath: /var/lib/app
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: app-data
```

### 扩容

```bash
# 前提：StorageClass 有 allowVolumeExpansion: true
kubectl patch pvc app-data -n prod -p \
  '{"spec":{"resources":{"requests":{"storage":"40Gi"}}}}'
kubectl get pvc app-data -n prod     # 观察 CAPACITY
```

两种扩容：

```
① 文件系统扩容（在线，立即生效）
② 块设备扩容（需要底层支持，有时要重启 Pod 或重建）
```

**不能缩容**：K8s 不支持缩小 PVC。需要缩小只能"新建小的 + 迁移数据"。

### 回收策略

```yaml
reclaimPolicy: Delete    # PVC 删除 → PV 与底层卷一起删
reclaimPolicy: Retain    # PVC 删除 → PV 保留（数据还在，需手动处理）
```

**生产建议 `Retain`**：误删 PVC 时数据还在，可以人工恢复。

查 PV 的当前状态：

```bash
kubectl get pv
# STATUS: Released（PVC 删了，PV 还有数据）
```

`Released` 的 PV 需要手动清理才能复用：

```bash
kubectl patch pv pv-xxx -p '{"spec":{"claimRef":null}}'
```

### "PVC 一直 Pending"的六种原因

| 原因 | 排查 |
| --- | --- |
| StorageClass 不存在 | `kubectl get sc` |
| provisioner 没运行 | `kubectl get pod -n <csi-ns>` |
| 请求的资源超过可用 | 看 provisioner 日志 |
| `WaitForFirstConsumer` 但没 Pod | 创建 Pod 后才会绑定 |
| 访问模式不支持 | 存储不支持 RWX 却申请了 RWX |
| 配额/权限问题 | 看 namespace ResourceQuota |

```bash
kubectl describe pvc app-data -n prod     # Events 里通常写明原因
kubectl logs -n <csi-ns> deploy/<provisioner> | tail -20
```

### 挂载失败（Pod 起不来）

| 现象 | 原因 |
| --- | --- |
| `MountVolume.SetUp failed` | NFS/Ceph 服务端不可达 |
| `permission denied` | 挂载点权限与 `fsGroup` 不匹配 |
| 卡在 `ContainerCreating` 很久 | 卷大、底层慢，或挂载超时 |
| `device busy` | RWO 卷被另一节点占用（旧 Pod 未完全退出） |

**RWO 抢占问题**：Pod 在新节点启动，但旧节点上还有残留的挂载 → 新节点挂不上。需要等旧 Pod 完全终止，或强制清理。

### 一个可用的生产配置

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ceph-rbd
provisioner: rbd.csi.ceph.com
parameters:
  clusterID: <id>
  pool: k8s
  imageFeatures: layering
  csi.storage.k8s.io/fstype: xfs
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

四行关键配置：`Retain`（防误删）、`allowVolumeExpansion`（能扩）、`WaitForFirstConsumer`（跟 Pod 走）、`xfs`（文件系统）。

### 检查清单

```
□ StorageClass 用 WaitForFirstConsumer
□ reclaimPolicy 生产用 Retain
□ allowVolumeExpansion 打开
□ 需要多节点读写时确认支持 RWX
□ provisioner 有监控（它挂了所有 PVC 都会 Pending）
□ 定期清理 Released 的 PV
□ 备份策略覆盖 PV 数据（PVC 不等于备份）
```
