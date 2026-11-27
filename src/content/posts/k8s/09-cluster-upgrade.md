---
title: Kubernetes 集群升级：版本顺序、风险点与回退边界
description: 版本偏斜规则与升级顺序、kubeadm 升级的实际步骤、API 变更导致的兼容问题、以及"升了之后不能降"的现实约束。
date: 2026-11-27
tags: [Kubernetes, 升级, kubeadm, 运维]
---

### 三条硬规则

1. **不能跨小版本升级**：1.28 → 1.31 必须走 1.29 → 1.30 → 1.31。
2. **版本偏斜（skew）**：kubelet 可比 apiserver 旧 2 个小版本，**但不能新**。
3. **不支持降级**：官方明确"升级不可逆"。想回退只能恢复 etcd 备份并重建。

### 升级顺序

```
① 控制面（先升第一个，验证，再升其余）
② kubelet / kube-proxy（逐节点）
③ 工作负载（按需，通常由应用团队）
④ 附加组件（CNI、CoreDNS、Ingress、CSI）
⑤ 集群内 Operator 与 CRD
```

顺序错了会出问题：先升 kubelet 而 apiserver 还是旧版本，可能因为新特性不被识别而报错。

### 升级前必做的四件事

```bash
# ① etcd 备份（最重要，没有它就没有退路）
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# ② 检查可升级版本
kubeadm upgrade plan

# ③ 检查已弃用 API
kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis

# ④ 检查组件兼容性
kubectl -n kube-system get deploy --show-labels
```

**弃用 API 是升级最大的坑**：1.25 移除了 PSP、1.26 移除部分 autoscaling/v2beta2、1.29 移除 flowcontrol v1beta。升级后这些对象会直接失效。

提前检测：

```bash
# 用 kubent / pluto 扫集群里的弃用资源
kubent
```

### kubeadm 升级步骤（单控制面）

```bash
# ① 升级 kubeadm
apt-get update && apt-get install -y kubeadm=1.29.0-1.1
kubeadm version

# ② 升级控制面组件
kubeadm upgrade apply v1.29.0
# 交互确认后，会升级 apiserver/controller-manager/scheduler/etcd

# ③ 升级 kubelet 与 kubectl
apt-get install -y kubelet=1.29.0-1.1 kubectl=1.29.0-1.1
systemctl daemon-reload && systemctl restart kubelet

# ④ 解除节点不可调度（如果是单节点集群）
kubectl uncordon <node>
```

多控制面时，其余节点用：

```bash
kubeadm upgrade node
```

### 工作节点升级（逐台进行）

```bash
# ① 驱逐（尊重 PDB）
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data

# ② 升 kubeadm + kubelet
apt-get install -y kubeadm=1.29.0-1.1 kubelet=1.29.0-1.1
kubeadm upgrade node
systemctl restart kubelet

# ③ 恢复调度
kubectl uncordon <node>
```

`drain` 的注意事项：

- `--ignore-daemonsets` 必须加（DaemonSet 的 Pod 无法驱逐）。
- `--delete-emptydir-data` 会删除 emptyDir 数据，有状态服务要确认。
- 有 PDB 的服务会阻止一次性驱逐太多，**没 PDB 的服务会被一次清空**。

### 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `kubeadm upgrade apply` 卡住 | etcd 健康检查失败 / 组件不健康 | 先 `kubectl get cs`（老版本）/ 查 `kubeadm upgrade plan` |
| 升级后 Calico 不工作 | CNI 版本与新内核/新 API 不兼容 | 升级 CNI 到匹配版本 |
| Pod 全部 Pending | kubelet 未连上 / CNI 未就绪 | `journalctl -u kubelet` |
| 某些对象报 "no matches for kind" | CRD 版本不匹配 | 先升级 Operator/CRD |
| 证书报错 | 升级过程证书未轮换 | `kubeadm certs check-expiration` |

### 证书这件事

kubeadm 的证书默认 1 年。升级会**自动续期控制面证书**，但**不续期 kubelet 客户端证书**（那由 kubelet 自己轮换）。

```bash
kubeadm certs check-expiration
kubeadm certs renew all      # 手动全量续期
```

忘记这件事的后果：一年后集群突然全部不可用（apiserver 证书过期）。

### 升级策略建议

| 集群 | 策略 |
| --- | --- |
| 生产 | 先升测试集群 → 灰度一个节点池 → 全量。版本落后不超过 1 个小版本 |
| 小团队 | 每季度升一次，跟住社区节奏，避免积压 |
| 托管 K8s | 控制面由厂商升级，重点管 kubelet 版本与工作负载兼容性 |

**不要长期停留在老版本**：积压 3 个版本后，升级会变成"一次跨三个版本的大手术"，风险指数级上升。

### 回退的现实

```
升级失败 → 恢复 etcd 快照 → 重装旧版本组件 → 重启
```

这条路径可行，但：

- 升级后**新写入的数据会丢失**（快照之后的所有变更）。
- 耗时通常 1–3 小时。
- 需要提前演练。

所以真正的策略是**先在非生产环境完整演练一遍升级**，而不是指望回退。

### 升级检查清单

```
□ etcd 快照已备份并验证可恢复
□ kubeadm upgrade plan 无报错
□ 弃用 API 已扫清（kubent 无输出）
□ CNI / CoreDNS / Ingress / CSI 版本匹配
□ 所有关键服务有 PDB
□ 逐节点 drain 的顺序已排好
□ 升级窗口与回滚决策点已明确（如"卡住 30 分钟就回退"）
```
