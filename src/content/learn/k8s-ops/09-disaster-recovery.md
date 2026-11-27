---
title: 第 9 章：备份恢复与集群灾难演练
module: 进阶篇
summary: etcd 恢复的完整流程、Velero 的边界、三个"最坏情况"的处置顺序，以及演练怎么设计。
minutes: 50
---

### 三个"最坏情况"

```
① 一个节点挂了（有冗余 → 影响小）
② 控制面全挂（etcd 可用则能救）
③ etcd 数据损坏/被误删（最严重）
```

**"最坏情况"** 才需要备份，日常故障靠冗余。

### etcd 恢复流程

```bash
# 1) 停所有控制面的 kube-apiserver / etcd
systemctl stop kubelet
systemctl stop etcd

# 2) 从快照恢复到一个新目录
etcdctl snapshot restore /backup/etcd-2026-11-27.db \
  --data-dir=/var/lib/etcd-restore

# 3) 替换数据目录（保留旧的以便二次抢救）
mv /var/lib/etcd /var/lib/etcd.broken
mv /var/lib/etcd-restore /var/lib/etcd

# 4) 起 etcd → 起控制面
systemctl start etcd
systemctl start kubelet
```

**注意**：

```
① 恢复后集群回到"快照时刻"（之后的对象全丢）
② 多控制面要按"member 信息"恢复（不是简单覆盖）
③ 恢复后要重建 CNI/插件（如它们也是 CRD）
```

### Velero 能做什么、不能做什么

```
能：命名空间级恢复、PV 数据（配 restic/CSI 快照）、定时备份
不能：恢复 CRD 定义本身（要先 apply CRD）、恢复 etcd 的 RBAC 全量状态
```

**"指望着 Velero 救整个集群"** → 它更擅长"应用级"恢复。

### 恢复顺序（关键）

```
① CRD / Operator
② 命名空间与 RBAC
③ 配置（ConfigMap/Secret）
④ 工作负载（Deployment/StatefulSet）
⑤ 数据（PV）
⑥ 入口（Ingress/证书）
```

**顺序错** → Pod 起不来（找不到 CRD 或 PVC）。

### 灾难演练怎么设计

```
场景 A：单节点断电 → 验证 Pod 漂移与容量
场景 B：etcd 快照恢复 → 验证"回到 1 小时前"的流程
场景 C：误删命名空间 → 验证 Velero 恢复
场景 D：存储后端不可用 → 验证业务降级
```

**每个场景都要记录**：

```
① 发现时间（监控有没有报）
② 处置耗时（对照 RTO）
③ 卡住的步骤（runbook 缺什么）
④ 改进项
```

### 五个"演练做成了表演"

**① 提前通知所有人**

```
真实故障不会通知
```

**② 只演练"顺利路径"**

```
跳过"快照损坏/网络不通"的分支
```

**③ 在生产环境"演练"**

```
风险不可控（应在隔离环境先做）
```

**④ 没有记录耗时**

```
无法证明 RTO 达标
```

**⑤ 演练完不改 runbook**

```
下次还是同样的坑
```

### 本章检查清单

```
□ etcd 每日快照 + 异地
□ 快照定期 restore 演练
□ Velero（或等价）覆盖应用
□ PV 数据也在备份范围
□ 恢复顺序写成 runbook
□ 每季度一次灾难演练（含异常分支）
□ 演练有耗时记录
□ 演练后更新 runbook
□ 有"最坏情况"的对外沟通预案
□ 关键数据有 Retain 策略
```
