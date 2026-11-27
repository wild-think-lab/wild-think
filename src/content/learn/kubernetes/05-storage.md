---
title: 第 5 章 · 存储：PV、PVC、StorageClass 与 StatefulSet
module: 熟练篇
summary: 三层存储模型、动态供给怎么走、访问模式的区别、StatefulSet 的稳定身份、以及"数据到底存在哪"的排查。
minutes: 18
---

### 三层结构

```
PV（PersistentVolume）        —— 集群里的"一块存储"，由管理员或驱动提供
PVC（PersistentVolumeClaim）  —— 用户的"申请单"：我要 10G、要能多节点读写
StorageClass                  —— "申请单的模板"，指定用什么存储、怎么创建
```

Pod 只认 PVC，不关心背后是 NFS 还是云盘。这层抽象让"换存储"不影响应用。

### 静态供给与动态供给

**静态**：管理员先建好 PV，PVC 来找匹配的。

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-nfs-01
spec:
  capacity: { storage: 10Gi }
  accessModes: [ReadWriteMany]
  persistentVolumeReclaimPolicy: Retain
  nfs:
    server: 192.168.1.40
    path: /data/pv01
```

**动态**（生产主流）：PVC 声明 StorageClass，驱动自动创建 PV。

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: kubernetes.io/aws-ebs    # 或 csi-nfs、longhorn、ceph-rbd
parameters:
  type: gp3
reclaimPolicy: Delete                 # 或 Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

`volumeBindingMode: WaitForFirstConsumer` 很关键：等 Pod 调度后再创建卷，避免"卷在 A 区、Pod 调度到 B 区"的拓扑冲突。

### PVC 与挂载

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: fast-ssd
  resources:
    requests: { storage: 20Gi }
```

```yaml
volumes:
- name: data
  persistentVolumeClaim: { claimName: app-data }
containers:
- name: app
  volumeMounts:
  - { name: data, mountPath: /var/lib/app }
```

### 三种访问模式

| 模式 | 含义 | 典型后端 |
| --- | --- | --- |
| ReadWriteOnce（RWO） | 单节点读写 | 云盘、本地盘 |
| ReadOnlyMany（ROX） | 多节点只读 | NFS、对象存储 |
| ReadWriteMany（RWX） | 多节点读写 | NFS、CephFS、部分 NAS |

**RWO 不等于"只能一个 Pod 用"**：同一节点的多个 Pod 可以共用。跨节点就不行——这是"两个副本挂同一块盘报错"的原因。

需要多副本共享写，只能用 RWX（NFS/CephFS），或者把状态外置（数据库、对象存储）。

### StatefulSet 的稳定身份

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
spec:
  serviceName: mysql-headless
  replicas: 3
  selector:
    matchLabels: { app: mysql }
  template:
    metadata:
      labels: { app: mysql }
    spec:
      containers:
      - name: mysql
        image: mysql:8.4
        volumeMounts:
        - { name: data, mountPath: /var/lib/mysql }
  volumeClaimTemplates:        # 每个副本自动一个 PVC
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: fast-ssd
      resources:
        requests: { storage: 50Gi }
```

它会保证三件事：

1. **稳定网络标识**：`mysql-0.mysql-headless`、`mysql-1...`
2. **稳定存储**：`data-mysql-0` 始终跟着 `mysql-0`
3. **有序启停**：默认 0→1→2 依次启动，删除时倒序

这三个保证是"数据库能跑在 K8s 上"的前提。但注意：**它只管调度与挂载，不管主从复制**，复制关系仍要应用自己（或用 Operator）建立。

### 数据到底存在哪

排查顺序：

```bash
kubectl -n prod get pvc
kubectl -n prod describe pvc app-data        # 看 Volume 与 Events
kubectl -n prod get pv pvc-xxxx              # 看真实后端
kubectl -n prod get pod app -o jsonpath='{.spec.volumes}'
```

常见状态：

| PVC 状态 | 原因 |
| --- | --- |
| Pending | 没有匹配的 PV / 驱动无法创建 / 容量不足 |
| Lost | PV 被删了但 PVC 还在 |
| Bound 但挂载失败 | 后端不可达（NFS 挂了、云盘被占用） |

`Pending` 时先看 `describe pvc` 的 Events，再去看 provisioner 的日志（如 `kubectl -n kube-system logs deploy/nfs-provisioner`）。

### 回收策略：Retain 还是 Delete

- `Delete`：PVC 删除后 PV 与后端存储一起删。**开发环境方便，生产危险**。
- `Retain`：PVC 删除后 PV 保留（状态变 Released），数据还在，需手工处理。

生产建议：**核心数据用 Retain**，删 PVC 不会连带删数据，多一道保险。

### 扩容

```bash
kubectl -n prod patch pvc app-data -p '{"spec":{"resources":{"requests":{"storage":"30Gi"}}}}'
kubectl -n prod get pvc app-data      # 看 CAPACITY 是否更新
```

前提是 StorageClass 开了 `allowVolumeExpansion: true`，且后端支持在线扩。扩容后有些文件系统需要手动 `resize2fs`（PVC 里通常自动处理），XFS 只能扩不能缩。

### 一句话总结

**Pod 只管声明 PVC，存储由 StorageClass 落地**。多副本共享写要 RWX，有状态服务用 StatefulSet，核心数据用 Retain。
