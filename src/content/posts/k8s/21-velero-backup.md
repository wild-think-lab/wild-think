---
title: K8s 备份与迁移：Velero 能救什么、救不了什么
description: Velero 的备份对象、恢复顺序、跨集群迁移的做法，以及五个"以为备份了其实没备"的坑。
date: 2026-11-27
tags: [Kubernetes, 备份, Velero]
---

### 先说清楚边界

**Velero 备份**：

```
① 集群资源（YAML：Deployment/Service/ConfigMap…）
② PV 里的数据（通过 restic/kopia 或云厂商快照）
```

**Velero 不备份**：

```
① etcd 本身（它不替代 etcd snapshot）
② 集群外的依赖（外部数据库、对象存储、DNS）
③ 镜像（恢复时要能重新拉取）
```

**"有 Velero 不等于集群可恢复"** —— etcd 与外部依赖要单独考虑。

### 备份什么（按价值排序）

```
① 命名空间里的全部资源（含 Secret）
② PVC 里的数据（真正难重建的部分）
③ CRD 与自定义资源（容易被忽略）
④ 集群级资源（StorageClass、IngressClass 等）
```

**"Secret 备份"** 很关键（否则恢复后全是空密码）。

### 基本命令

```bash
# 全量备份（默认只备份资源，不含卷）
velero backup create full-$(date +%F)

# 带卷
velero backup create full-vol --include-volumes

# 指定命名空间
velero backup create app-ns --include-namespaces app

# 排除
velero backup create no-mon --exclude-namespaces kube-system,monitoring

# 查看
velero backup get
velero backup describe full-2026-11-27 --details

# 恢复
velero restore create --from-backup full-2026-11-27
```

**建议**：

```
日常：资源备份（每天）
周备：带卷的全量（每周）
```

### 恢复顺序（很多人搞错）

```
① 先恢复 CRD（否则自定义资源无法创建）
② 再恢复集群级资源（StorageClass/IngressClass）
③ 再恢复命名空间资源
④ 最后校验 PVC 数据挂载正确
```

**Velero 默认会按优先级处理一部分，但"跨集群恢复"必须自己确认 CRD 已存在**。

**恢复时的两个关键参数**：

```bash
velero restore create --from-backup b1 \
  --include-namespaces app \
  --restore-volumes=true \
  --exclude-resources pods,services,deployments \
  --namespace-mappings old-ns:new-ns
```

**`--exclude-resources` 常用于"只恢复数据，不要覆盖现有工作负载"**。

### 跨集群迁移

```
① 源集群备份（含卷）
② 把备份存储（S3/对象存储）指向同一位置
③ 目标集群安装 Velero（同一 bucket）
④ 在目标集群 restore
```

**前提：目标集群必须先有**：

```
① 同名的 StorageClass（否则 PVC 无法绑定）
② 目标节点有足够容量
③ 网络能拉取原镜像
```

**"StorageClass 名字不一致"是迁移失败的头号原因**。

**镜像问题**：

```
原集群用私有镜像仓库 → 目标集群也要能访问
或先把镜像同步过去（skopeo/crane）
```

### 五个"以为备份了其实没备"的坑

**① 只备份资源，没备份卷**

```
默认 `--include-volumes` 是关的（取决于配置）
→ PVC 里的数据完全没备
```

**② PVC 用的是 hostPath / local-path**

```
Velero 的卷备份对 hostPath 支持有限
→ 数据其实没进备份
```

**③ 备份存储和集群在同一个故障域**

```
S3 与集群在同一个机房 → 机房断电一起丢
```

**④ 没备份 CRD**

```
恢复时 "no matches for kind xxx" → 资源全部跳过
```

**⑤ 从没恢复演练**

```
备份看着每天成功，恢复时发现"卷恢复不了/权限不对"
```

### 一个"可信"的验证方法

```
每月：在隔离的测试集群做一次完整恢复
  → 起服务 → 打一个健康检查 → 与生产数据抽样比对
```

**"恢复演练"是唯一验收标准**（跟数据库备份同理）。

### 与 etcd 备份的分工

```
etcd snapshot：整个集群状态的"时间点"（含所有资源）
Velero       ：按命名空间/资源的"选择性"备份 + 卷数据
```

**建议两个都做**：

```
etcd 每天快照（快速回滚整个集群）
Velero 每天资源 + 每周卷（精确恢复某个业务）
```

### 检查清单

```
□ Velero 已部署，schedule 已配置
□ 明确是否含卷（--include-volumes）
□ 卷类型支持（不用 hostPath/local-path 存关键数据）
□ CRD 在备份范围
□ 备份存储异地（不同故障域）
□ 保留策略（如 7 天/4 周/6 月）
□ etcd snapshot 独立执行
□ 外部依赖（DB/对象存储/DNS）有各自备份
□ 目标集群 StorageClass 已预建（迁移场景）
□ 每月恢复演练
□ 监控备份任务成功与卷大小
```
