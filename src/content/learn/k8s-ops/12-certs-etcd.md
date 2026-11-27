---
title: 证书与 etcd 运维
module: 进阶篇
summary: 集群证书到期排查与续期、etcd 健康与性能、快照恢复流程，五个"证书过期全集群瘫"的原因。
minutes: 45
---

### 证书是集群的隐形定时炸弹

```bash
kubeadm certs check-expiration
```

**关注**：

```
① apiserver / apiserver-kubelet-client
② etcd-server / etcd-peer
③ front-proxy-client
④ CA 本身（10 年，但也要记）
```

**"集群突然全挂，日志全是 x509"** → 证书到期。

### 续期（kubeadm 集群）

```bash
kubeadm certs renew all
# 控制面组件需要重启才加载新证书
systemctl restart kubelet
# 静态 Pod（apiserver/controller-manager/scheduler/etcd）需重建
```

```bash
# 静态 Pod 重建方式（移到别的目录会被 kubelet 重新生成）
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 20
mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
```

**注意**：kubeconfig 里嵌入的证书也要更新（否则 kubectl 报错）。

### etcd 健康三件事

```bash
etcdctl endpoint health --cluster
etcdctl endpoint status --cluster -w table
```

```
① 健康：所有成员 healthy
② 延迟：fsync 延迟（disk）
③ 容量：DB 大小与配额（默认 2GB/8GB）
```

```bash
etcdctl alarm list      # NOSPACE 告警最常见
```

**"NOSPACE"** → 配额满，整个集群变只读（写入全失败）。

### etcd 性能要点

```
① 专用 SSD（fsync 慢会拖垮整个控制面）
② 不与高 IO Pod 共盘
③ 成员数为奇数（3/5）
④ 心跳与选举超时按网络延迟调
⑤ 定期 defrag（回收碎片）
```

### 快照恢复（真的要练）

```bash
# 1. 停所有控制面与 kubelet
systemctl stop kubelet
# 2. 恢复
etcdctl snapshot restore /backup/etcd.db \
  --data-dir=/var/lib/etcd-restore
# 3. 改 etcd 配置指向新 data-dir
# 4. 启动 etcd → 验证 → 启动 kubelet
```

**判据**：恢复后 `kubectl get nodes` 与恢复时间点一致。

**"备份了但没恢复过"** → 真出事时不知道怎么改 data-dir。

### 五个"证书过期全集群瘫"

**① 没人监控到期**

```
到期当天 apiserver 拒绝所有连接
```

**② 只续了 apiserver**

```
etcd/kubelet 客户端证书还旧 → 组件间不通
```

**③ kubeconfig 未更新**

```
kubectl 报 "certificate has expired"
```

**④ CA 到期**

```
无法续签，只能重建集群（极端）
```

**⑤ 续期后没重启组件**

```
文件换了但进程还是旧证书
```

### 监控项

```
① 证书剩余天数（< 60 天告警）
② etcd 成员健康
③ etcd DB 大小与配额使用率
④ etcd fsync 延迟
⑤ apiserver 请求错误率（含 401/403 突增）
```

### 检查清单

```
□ 证书到期有监控（60/30/7 天）
□ 续期流程有文档（含静态 Pod 重建）
□ kubeconfig 更新步骤明确
□ CA 到期时间已记录
□ etcd 成员为奇数
□ etcd 在 SSD 上
□ 有 NOSPACE 告警
□ 定期 defrag
□ 快照每日 + 异地
□ 恢复演练做过至少一次
```
