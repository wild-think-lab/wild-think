---
title: 集群升级与节点维护
module: 进阶篇
summary: 版本升级的顺序与验证、节点 drain/cordon、内核与容器运行时升级，五个"升级后就地出事"的原因。
minutes: 45
---

### 升级前必做四件事

```
① 备份 etcd（快照）
② 读版本兼容矩阵（kubeadm 只能小版本 +1）
③ 确认工作负载有 PDB
④ 准备回滚方案（etcd 快照 + 旧版本包）
```

**"跳两个小版本升"** → kubeadm 直接拒绝或组件不一致。

### 控制面升级（kubeadm）

```bash
# 第一个控制面节点
apt-mark unhold kubeadm && apt-get install -y kubeadm=1.30.x-*
kubeadm upgrade plan
kubeadm upgrade apply v1.30.x
# 其他控制面节点用 node 子命令
kubeadm upgrade node
# 最后升 kubelet/kubectl 并重启
systemctl daemon-reload && systemctl restart kubelet
```

**顺序**：先控制面（逐个），再工作节点（可批量）。

### 工作节点升级

```bash
kubectl drain node1 --ignore-daemonsets --delete-emptydir-data
# 升 kubeadm → kubeadm upgrade node → 升 kubelet
kubectl uncordon node1
```

**`drain` 会驱逐 Pod** → 没有 PDB 时可能整服务下线。

### 节点维护（日常）

```bash
kubectl cordon node1        # 不再调度新 Pod
kubectl drain node1 --ignore-daemonsets --delete-emptydir-data
# 维护...
kubectl uncordon node1
kubectl get nodes
```

**判据**：`drain` 卡住 → 看是否有裸 Pod（无控制器）或本地存储。

### etcd 升级与维护

```bash
# 快照（升级前必做）
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
etcdctl snapshot status /backup/etcd-$(date +%F).db
```

```bash
# 碎片整理（大集群定期做）
etcdctl defrag --command-timeout=30s
```

**"etcd 从没备份"** → 升级失败等于集群重建。

### 容器运行时升级

```
① containerd 升级要逐节点（会重启容器）
② drain 之后再升
③ 验证：Pod 能正常拉起、镜像能拉
```

**"直接 systemctl restart containerd 全集群"** → 大规模 Pod 重启。

### 五个"升级后就地出事"

**① 版本不匹配**

```
kubelet 版本高于 apiserver 太多 → NotReady
```

**② CNI 插件没升级**

```
新版本 API 变了 → 网络不通
```

**③ 应用依赖旧 API**

```
已废弃的 API 被移除 → 部署失败
```

```bash
kubectl get --raw /metrics | grep apiserver_request_total
# 或用 kubent / pluto 扫描废弃 API
```

**④ 没做 drain 就重启**

```
节点上 Pod 全部中断
```

**⑤ 回滚没验证**

```
快照存在但从未恢复过
```

### 检查清单

```
□ 升级前 etcd 快照 + 验证快照可用
□ 版本兼容矩阵已核对
□ 有 PDB
□ 控制面逐个升级
□ 工作节点 drain → 升级 → uncordon
□ CNI/CSI 同步升级
□ 废弃 API 已扫描
□ 升级后跑核心业务验证
□ 有回滚演练记录
□ 升级窗口与通知到位
```
