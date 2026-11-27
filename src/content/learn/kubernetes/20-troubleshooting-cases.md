---
title: 集群排障案例集：十个真实故障
module: 进阶篇
summary: 从 Pod Pending 到 etcd NOSPACE，十个高频故障的现象、判据、命令与根因。
minutes: 50
---

### 用法

每个案例按 **现象 → 一条命令 → 判据 → 根因 → 处置** 组织。遇到时按关键词找，别从第一条读。

### ① Pod Pending

```bash
kubectl describe pod app-0 | tail -15
```

**判据**：Events 写 `0/3 nodes are available: 3 Insufficient cpu` 或 `node(s) had untolerated taint`。

**根因**：requests 超过单节点可分配量 / 污点不匹配 / 亲和条件矛盾。

### ② CrashLoopBackOff

```bash
kubectl logs app-0 --previous --tail=50
```

**判据**：上次退出码 1（应用错）或 137（OOM/SIGKILL）。

**根因**：配置错误、依赖未就绪、内存超限。

### ③ ImagePullBackOff

```bash
kubectl describe pod app-0 | grep -A3 "Failed to pull"
```

**判据**：`unauthorized` → 拉取密钥缺失；`not found` → tag 错；`timeout` → 网络。

**根因**：私有仓库未配 imagePullSecret。

### ④ OOMKilled 反复重启

```bash
kubectl get pod app-0 -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'
```

**判据**：`OOMKilled`；对照 `limits.memory` 与进程实际 RSS。

**根因**：limit 太小或内存泄漏（重启只是掩盖）。

### ⑤ Service 通但无流量

```bash
kubectl get endpoints app
```

**判据**：`Endpoints` 为空。

**根因**：Service 的 selector 与 Pod 标签不匹配；或 Pod 未 Ready（readiness 失败也会被移出 endpoints）。

### ⑥ DNS 解析失败

```bash
kubectl exec -it app-0 -- cat /etc/resolv.conf
kubectl exec -it app-0 -- nslookup kubernetes.default
```

**判据**：`resolv.conf` 指向的 CoreDNS 不可达，或 `ndots` 导致大量无效查询。

**根因**：CoreDNS 挂 / NetworkPolicy 拦了 53 端口 / 集群网络插件异常。

### ⑦ 节点 NotReady

```bash
kubectl describe node node1 | grep -A5 Conditions
systemctl status kubelet
journalctl -u kubelet -n 50
```

**判据**：`KubeletNotReady`，常见 `PLEG is not healthy` 或磁盘压力。

**根因**：容器运行时无响应、磁盘满、时钟漂移。

### ⑧ etcd NOSPACE

```bash
kubectl -n kube-system logs etcd-node1 | grep -i "space"
etcdctl alarm list
```

**判据**：`NOSPACE` 告警 → 集群变只读，所有写操作失败（包括创建 Pod）。

**根因**：DB 配额满（历史事件过多/大量小对象）。处置：扩容配额 + defrag。

### ⑨ 证书过期

```bash
kubeadm certs check-expiration
```

**判据**：`EXPIRED`；apiserver 日志大量 `x509: certificate has expired`。

**根因**：无人监控到期时间。处置：`kubeadm certs renew all` + 重启静态 Pod。

### ⑩ NetworkPolicy 拦了流量

```bash
kubectl exec -it client -- nc -zv order 8080
kubectl get networkpolicy -n app
```

**判据**：`nc` 超时，但同 Pod 内访问 localhost 正常。

**根因**：默认拒绝 + 未放行 DNS/目标端口；或 CNI 不支持策略导致"看似失效"。

### 三个通用动作

```
① 先 describe 看 Events（90% 的答案在这）
② 再 logs --previous（崩溃前的那次）
③ 最后才怀疑集群/网络（顺序反了会浪费一小时）
```

### 检查清单（自查集群健康）

```
□ 所有节点 Ready
□ 系统组件 Pod 无重启
□ etcd 健康且无 NOSPACE
□ 证书 > 60 天
□ 无 Pending 超 10 分钟的 Pod
□ 无 CrashLoopBackOff
□ CoreDNS 解析正常
□ 磁盘水位 < 80%
□ apiserver 5xx 无异常
□ 事件里无高频 Warning
```
