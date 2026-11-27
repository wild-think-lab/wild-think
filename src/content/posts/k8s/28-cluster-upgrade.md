---
title: K8s 集群升级：一次不宕机的实战顺序
description: 版本约束、升级顺序、节点分批与回滚、五个"升完就出问题"的原因。
date: 2026-10-04
tags: [Kubernetes, 运维, 升级]
---

### 三条硬约束

```
① 不能跨小版本（1.25 → 1.27 要经过 1.26）
② 控制面先升，再升 kubelet
③ 不能降级（官方不支持，只能重建）
```

**"直接跳两个版本"** 是最常见的翻车点。

### 升级前的检查

```bash
# 版本偏差（kubelet 不能高于 apiserver）
kubectl version --short
kubectl get nodes -o wide

# 已弃用 API（升级前必须处理）
kubectl get --raw /metrics | grep apiserver_request_total
# 用 kubent / pluto 扫
kubent

# 组件兼容性
kubectl get pods -n kube-system
```

**"API 弃用"** 是升级后 Pod 起不来的第一原因（如 Ingress/PSP/HPA v2beta）。

### 升级顺序（kubeadm）

```
1) 备份 etcd（必须）
2) 升级第一个控制面节点（kubeadm upgrade plan / apply）
3) 升级其余控制面
4) 升级 kubelet/kubectl（每台）
5) 逐台升级工作节点（先 drain）
6) 升级插件（CNI/CSI/CoreDNS/metrics-server）
```

**"先升工作节点"** 会导致 kubelet 版本高于 apiserver（不被支持）。

### 单节点操作（工作节点）

```bash
kubectl drain node-1 --ignore-daemonsets --delete-emptydir-data
# 在该节点
apt-get install -y kubelet=1.28.x-* kubeadm=1.28.x-*
kubeadm upgrade node
systemctl restart kubelet
kubectl uncordon node-1
```

**关键**：`drain` 之后要确认"Pod 在别处起来了"，再操作。

```bash
kubectl get pods -A -o wide | grep node-1
```

### etcd 备份（升级前）

```bash
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

etcdctl snapshot status /backup/etcd-$(date +%F).db
```

**"备份了但没验证"** 等于没备份（status 必须成功）。

### 五个"升完就出问题"

**① 弃用 API 的清单没跟上**

```
Ingress v1beta1 → v1
PSP 被移除（1.25）
HPA autoscaling/v2beta2 → v2
```

**② CNI 版本不兼容**

```
老版本 Calico 不支持新内核/新 API
→ 升级前先确认 CNI 支持矩阵
```

**③ kubelet 与容器运行时版本不匹配**

```
containerd 太老 → kubelet 起不来
```

**④ 证书过期**

```
升级时才发现证书过期 → 卡住
→ 提前 kubeadm certs check-expiration
```

**⑤ 工作负载没有 PDB**

```
drain 时全部副本被驱逐 → 业务中断
```

**解决**：关键服务配 PDB

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: {name: app-pdb}
spec:
  minAvailable: 2
  selector: {matchLabels: {app: myapp}}
```

### 回滚策略（现实版）

```
① 控制面：可以"回退到旧版本二进制"（不推荐，风险高）
② 工作节点：重新装旧版 kubelet（可行）
③ 应用：kubectl apply 回旧清单（可行）
④ 最稳的做法：升级前"快照整个集群"（VM 快照/etcd 备份）
```

**"升级不可回滚"** → 所以必须"先演练"（在测试集群跑一遍）。

### 一次"分批"策略

```
批次 1：测试集群（全流程）
批次 2：1 个非关键工作节点
批次 3：25% 工作节点（观察 24h）
批次 4：剩余
```

**"一次性全升"** 在生产环境几乎必然出问题。

### 升级后的验证

```bash
kubectl get nodes          # 全 Ready
kubectl get pods -A        # 无 CrashLoop
kubectl get --raw /healthz # 健康
# 业务侧
kubectl run curl --image=curlimages/curl --rm -it -- sh
```

**"只看节点 Ready"** 不够（网络/存储插件可能挂了）。

### 检查清单

```
□ 版本不跨小版本
□ 用 kubent/pluto 扫弃用 API
□ 升级前 etcd 快照 + 验证
□ 证书未过期
□ CNI/CSI 版本兼容
□ PDB 已配置
□ 控制面 → kubelet → 工作节点顺序
□ 工作节点逐台 drain
□ 分批升级 + 观察窗口
□ 测试集群演练过
□ 升级后验证 Pod/网络/存储
□ 有"回退到旧版"的可执行方案
```
