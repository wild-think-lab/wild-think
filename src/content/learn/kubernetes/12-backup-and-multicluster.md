---
title: 第 12 章 · 备份、恢复与多集群
module: 进阶篇
summary: 要备份什么（etcd/资源/镜像/PV）、Velero 的用法、多集群的三种动机与代价。
minutes: 50
---

### 要备份的四样东西

```
① etcd（集群状态：对象、RBAC、CRD）
② 工作负载清单（YAML，最好在 Git 里）
③ 镜像（仓库/离线包）
④ 持久化数据（PV/PVC 背后的存储）
```

**"只备份 etcd"** → PV 里的数据没有，恢复后业务空库。

### etcd 快照

```bash
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

etcdctl snapshot status /backup/etcd-$(date +%F).db -w table
```

**"备份了没验证"** → status 必须成功，且定期做一次 restore 演练。

### Velero：面向"命名空间级"恢复

```bash
velero install --provider aws --bucket k8s-backup \
  --plugins velero/velero-plugin-for-aws:v1.8.0 \
  --secret-file ./credentials --use-volume-snapshots=false

velero backup create app-$(date +%F) --include-namespaces app
velero backup describe app-2026-11-27 --details
velero restore create --from-backup app-2026-11-27
```

**注意**：

```
① PV 数据要配 restic/kopia 或 CSI 快照（否则只备份了"声明"）
② 恢复时 CRD 要先恢复（顺序问题）
③ 备份要异地（对象存储）
```

### 恢复演练（每季度）

```
1) 起一个空集群（或命名空间）
2) 恢复 CRD → 恢复工作负载 → 恢复数据
3) 验证 Service/Ingress 可用
4) 记录耗时（RTO）
```

**"演练只恢复 YAML"** 会发现数据没回来。

### 多集群的三种动机

```
① 隔离（生产/测试、不同团队）
② 容灾（同城/异地双活）
③ 规模（单集群到上限）
```

**代价**：

```
① 运维成本 ×N
② 跨集群网络与身份
③ 发布与配置的一致性
④ 监控与告警的聚合
```

### 多集群的三条路

```
① 独立集群 + 统一 GitOps（推荐起步）
② 集群联邦（Kubefed，生态弱）
③ 托管多集群平台（如 Rancher/云厂商）
```

**"一上来就双活"** 通常卡在"数据一致性"。

### 本章检查清单

```
□ etcd 定期快照 + 验证
□ 工作负载清单在 Git
□ PV 数据有备份（restic/CSI 快照）
□ 有 Velero 或等价方案
□ 每季度恢复演练
□ 备份异地存放
□ 多集群有明确动机
□ 有统一 GitOps 或配置分发
□ 有跨集群监控聚合
□ 有"集群不可用"的切换预案
```
