---
title: 存储实战：PV / PVC / StorageClass 与有状态服务
module: 进阶篇
summary: 三种访问模式、动态供给、StatefulSet 的卷模板、扩容与快照，五个"数据丢了"的原因。
minutes: 50
---

### 三个对象的关系

```
StorageClass（怎么供给：NFS/CSI/云盘）
  └ → PV（一块实际存储）
        └ → PVC（Pod 的申请单）
```

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: data }
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: fast-ssd
  resources: { requests: { storage: 20Gi } }
```

**要点**：`storageClassName: ""` 表示"只用静态 PV"，会绑不上动态供给。

### 访问模式

```
RWO：单节点读写（块存储常用）
ROX：多节点只读
RWX：多节点读写（NFS/CephFS 才可靠）
```

**"数据库用 RWX"** → 多副本同时写同一卷，数据必坏。

### 动态供给（StorageClass）

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: { name: fast-ssd }
provisioner: driver.example.com/csi
parameters: { type: ssd }
reclaimPolicy: Retain       # 删 PVC 后 PV 保留（防误删数据）
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

**`WaitForFirstConsumer`** 让卷在 Pod 调度后再创建（跟可用区/节点对齐）。

### StatefulSet 的卷模板

```yaml
volumeClaimTemplates:
  - metadata: { name: data }
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: fast-ssd
      resources: { requests: { storage: 50Gi } }
```

**效果**：`data-web-0`、`data-web-1` 各自独立卷；删 Pod 不删卷（数据在）。

### 扩容

```bash
kubectl patch pvc data -p '{"spec":{"resources":{"requests":{"storage":"40Gi"}}}}'
kubectl get pvc data -w
```

**前提**：StorageClass 有 `allowVolumeExpansion: true`，且 CSI 支持在线扩容。

### 备份与快照

```bash
# 卷快照（CSI Snapshot 或存储侧快照）
kubectl get volumesnapshot
# 应用层备份更可靠（mysqldump 到对象存储）
```

**判据**：卷快照不等于应用一致（数据库要 flush 后才能快照）。

### 五个"数据丢了"

**① 删了 PVC 连带删 PV**

```
reclaimPolicy: Delete（默认）→ PV 被销毁
```

**② 用 emptyDir 存数据**

```
Pod 重启即清空
```

**③ 多副本共用一个 RWO 卷**

```
调度到不同节点 → 挂载失败或数据损坏
```

**④ 没考虑节点亲和**

```
本地盘 PV 绑在节点 A，Pod 调度到 B → Pending
```

**⑤ 备份只做在集群内**

```
集群整体故障 → 备份一起没了
```

### 排查命令

```bash
kubectl get pvc,pv -A
kubectl describe pvc data            # Events 里写绑定失败原因
kubectl get sc
kubectl get events --sort-by=.lastTimestamp | tail -20
```

### 检查清单

```
□ 明确访问模式（写类用 RWO）
□ StorageClass 有 reclaimPolicy: Retain（重要数据）
□ 有 WaitForFirstConsumer
□ StatefulSet 用 volumeClaimTemplates
□ 扩容能力已验证
□ 备份在集群外
□ 有 PV/PVC 绑定失败告警
□ 有容量水位告警
□ 有卷快照 + 应用一致性方案
□ 本地盘 PV 有节点亲和
```
