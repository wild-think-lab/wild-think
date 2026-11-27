---
title: 第 3 章：集群升级不回滚
module: 入门篇
summary: 版本约束与顺序、弃用 API 扫描、etcd 快照、逐台 drain、升级后验证清单。
minutes: 45
---

### 三条硬约束（先记这三条）

```
① 不跨小版本（1.25 → 1.27 必须经过 1.26）
② 控制面先升，kubelet 后升
③ 不支持降级（只能重建或快照回滚）
```

### 升级前必做的四件事

**① 扫弃用 API**

```bash
kubent
# 或
kubectl get ingresses -A -o yaml | grep -i "apiVersion"
```

**② etcd 快照并验证**

```bash
etcdctl snapshot save /backup/etcd.db --endpoints=... 
etcdctl snapshot status /backup/etcd.db
```

**③ 检查证书**

```bash
kubeadm certs check-expiration
```

**④ 确认插件版本矩阵**

```
CNI（Calico/Cilium）、CSI、CoreDNS、metrics-server、Ingress Controller
```

### 升级顺序

```
1) 第一个控制面：kubeadm upgrade plan → apply
2) 其余控制面：同上（一次一台）
3) 每台 kubelet/kubectl
4) 工作节点：drain → 升 → uncordon（逐台）
5) 插件
```

**"先升 kubelet"** 会让 kubelet 版本高于 apiserver（不被支持）。

### 控制面操作

```bash
kubeadm upgrade plan
kubeadm upgrade apply v1.28.4
# 然后每台
apt-get install -y kubelet=1.28.4-* kubeadm=1.28.4-* kubectl=1.28.4-*
systemctl restart kubelet
```

### 工作节点操作

```bash
kubectl drain node-1 --ignore-daemonsets --delete-emptydir-data
# 在 node-1 上
apt-get install -y kubelet=1.28.4-* kubeadm=1.28.4-*
kubeadm upgrade node
systemctl daemon-reload && systemctl restart kubelet
kubectl uncordon node-1
```

**drain 后必须确认**：

```bash
kubectl get pods -A -o wide | grep node-1   # 应只剩 DaemonSet
```

### 五个"升完就出问题"

```
① 弃用 API（Ingress v1beta1 / PSP / HPA v2beta2）
② CNI 不兼容新内核
③ containerd 太老
④ 证书过期
⑤ 没有 PDB → drain 时全量驱逐
```

### 升级后验证

```bash
kubectl get nodes                  # 全 Ready 且版本一致
kubectl get pods -A | grep -v Running
kubectl get --raw /healthz
kubectl run net --image=nicolaka/netshoot --rm -it -- sh -c "nslookup kubernetes.default"
```

**"只测节点 Ready"** 不够，网络/存储插件常在这时出问题。

### 本章检查清单

```
□ 不跨版本
□ 弃用 API 清单已处理
□ etcd 快照已验证
□ 证书未过期
□ 插件版本矩阵确认
□ 有测试集群演练
□ 逐台 drain + uncordon
□ 有 PDB
□ 升级后验证 Pod/网络/存储
□ 有快照级回滚方案
```
