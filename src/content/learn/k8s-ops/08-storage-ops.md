---
title: 第 8 章：存储运维：扩容、迁移与回收
module: 熟练篇
summary: PVC 扩容、卷迁移、快照与克隆、存储性能排查,以及五个"盘扩了但容量没变"的原因。
minutes: 50
---

### 存储的三个组件

```
StorageClass（类型与参数）
PV（一块实际存储）
PVC（应用声明的需求）
```

**"PVC 绑定了 PV"** 之后不能再换 SC（除迁移）。

### 扩容

```bash
kubectl patch pvc data-app-0 -p \
  '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'
kubectl describe pvc data-app-0 | grep -i capacity
```

**前提**：

```
① SC 的 allowVolumeExpansion: true
② 后端支持在线扩容
③ 文件系统支持（xfs 可扩，ext4 可扩）
```

**"改了 PVC 大小但 df 没变"** → 文件系统没 resize（部分 CSI 需要重启 Pod 或手工 growfs）。

### 快照与克隆

```bash
# CSI 快照（VolumeSnapshot CRD）
kubectl apply -f snapshot.yaml
kubectl get volumesnapshot

# 从快照恢复（创建新 PVC 指向快照）
```

**用途**：

```
① 升级前的"回滚点"
② 快速给测试环境一份数据
```

### 卷迁移（换 SC / 换后端）

```
① 新 PVC（新 SC）
② 停写（或短暂维护窗口）
③ rsync/cp 数据
④ 改 Deployment 指向新 PVC
⑤ 观察 → 删旧 PVC
```

**"直接改 SC"** 不行（PVC 的 SC 不可变）。

### 存储性能排查

```bash
kubectl exec -it app-0 -- sh -c "dd if=/dev/zero of=/data/test bs=1M count=200 conv=fdatasync"
kubectl exec -it app-0 -- sh -c "cat /data/test > /dev/null"
```

**判据**：

```
写 < 50MB/s（云盘/网络存储常见）→ 业务若要高 IO 就不合适
延迟 p99 高 → 后端拥塞
```

### 五个"盘扩了但容量没变"

**① SC 不允许扩容**

```
allowVolumeExpansion: false
```

**② 文件系统没 resize**

```
扩容 PVC 后需要 growfs（部分 CSI 自动，部分不自动）
```

**③ 已挂载但未重新扫描**

```
iSCSI/多路径需 rescan
```

**④ PVC 有多个挂载者**

```
RWO 卷被多 Pod 挂 → 扩容行为不确定
```

**⑤ 后端配额到顶**

```
云盘/存储池已满 → 扩不了
```

### 回收策略（PV 的三种）

```
Retain    删除 PVC 后 PV 保留（数据还在，需手工清理）
Delete    删除 PVC 后自动删后端存储（危险）
Recycle   已废弃
```

**"默认 Delete + 误删 PVC"** = 数据直接没了。

### 本章检查清单

```
□ SC 明确 allowVolumeExpansion
□ 有扩容流程（含文件系统 resize）
□ 有快照能力（升级前打点）
□ 迁移方案（新 PVC + 数据同步）
□ 存储性能有基线
□ 回收策略明确（关键数据用 Retain）
□ 有 PVC 使用率监控
□ 有多挂载（RWX）需求评估
□ 有"卷挂不上"的 runbook
□ 备份覆盖 PV 数据
```
