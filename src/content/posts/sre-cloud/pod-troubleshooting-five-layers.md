---
title: Pod 起不来的五层排查法：从 Pending 到 CrashLoopBackOff
description: K8s 里"Pod 不健康"是一句无效描述。按调度—网络—存储—镜像—进程五层拆解，每一层都有对应的 describe/events/logs 判据。
date: 2026-04-11
tags: [Kubernetes, Pod, 排障, 云原生, SRE]
---

排查 Pod 的第一步永远是把状态说清楚：`Pending`、`ContainerCreating`、`ImagePullBackOff`、`CrashLoopBackOff`、`Running 但不 Ready`——这五种状态的成因完全不同。

```bash
kubectl get pod -o wide
kubectl describe pod <pod>        # 先看 Events，90% 的答案在这
kubectl logs <pod> --previous     # CrashLoop 必须看上一个容器实例
```

## 第一层：调度（Pending）

Pod 已创建但没有被分配到节点。Events 里通常是 `0/3 nodes are available: ...`。

| 事件关键词 | 原因 | 处理 |
| --- | --- | --- |
| `Insufficient cpu/memory` | requests 超过节点可分配量 | 降 requests 或扩容 |
| `node(s) had taint` | 节点污点不匹配 | 加 toleration 或去污点 |
| `didn't match node selector/affinity` | 标签或亲和性不满足 | 修 selector 或给节点打标签 |
| `no available volume zone` | PV 的可用区与节点不一致 | 调整 topology 或 PV |
| `exceeded quota` | 命名空间配额耗尽 | 提配额或清理 |

```bash
kubectl describe node <node> | grep -A5 Allocatable
kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints
kubectl describe quota -n <ns>
```

常见坑：**requests 设成 0** 时调度很容易成功，但节点上实际资源不够，表现为"起来后立刻被 OOM 或频繁驱逐"。requests 应反映真实需求，limits 才是上限。

## 第二层：网络（ContainerCreating 卡住 / 起来了但连不通）

- CNI 插件异常：`kubectl -n kube-system logs <cni-pod>` 看 IP 分配是否失败。
- IP 池耗尽：`calico`/`flannel` 的 IPAM 用尽时会卡在 ContainerCreating。
- 跨节点不通：检查 kube-proxy、节点间防火墙、隧道 MTU。

```bash
kubectl -n kube-system get pod | grep -E 'calico|flannel|cni|kube-proxy'
kubectl exec -it <pod> -- sh -c 'ip a; ip route'
```

**DNS 是最常见的"网络问题"**：Pod 内 `nslookup kubernetes.default` 不通，先看 `/etc/resolv.conf` 与 CoreDNS 状态，而不是怀疑业务代码。

## 第三层：存储（挂载失败）

Events 里出现 `FailedMount`、`Unable to attach or mount volumes`。

- PVC 未 Bound：`kubectl get pvc` 看状态，`describe` 看 provisioning 报错。
- StorageClass 不存在或参数错：`kubectl get sc`。
- NFS 服务端不可达或权限不对：在节点上手动 `mount -t nfs ...` 验证。
- RWX 与 RWO 用错：多副本共享写必须 RWX，RWO 只能单节点挂载。

## 第四层：镜像（ImagePullBackOff / ErrImagePull）

```bash
kubectl describe pod <pod> | grep -A3 'Failed'   # 会写明具体错误
```

| 错误 | 原因 |
| --- | --- |
| `manifest unknown` | tag 不存在或写错 |
| `unauthorized` | imagePullSecret 缺失/过期 |
| `dial tcp ... i/o timeout` | 节点到 registry 网络不通 |
| `x509 certificate` | 私有 registry 证书不受信 |

注意 `imagePullPolicy`：`:latest` 默认 `Always`，固定 tag 默认 `IfNotPresent`——改了镜像但 tag 没变时，节点可能一直用旧镜像。

## 第五层：进程（CrashLoopBackOff / Running 但 NotReady）

到这里才是应用自身的问题。

```bash
kubectl logs <pod> --previous --tail=100
kubectl describe pod <pod> | grep -E 'Last State|Exit Code|Reason|OOMKilled'
```

按退出码判断：

| 退出码 | 含义 | 排查方向 |
| --- | --- | --- |
| 0 | 正常退出 | 主进程跑完了，检查启动命令是否该常驻 |
| 1 | 应用异常 | 看日志首个错误堆栈 |
| 137 | SIGKILL / OOM | 看 `OOMKilled` 是否为 true，调 limits |
| 143 | SIGTERM | 被优雅终止，检查探针或部署抖动 |
| 126/127 | 权限/命令不存在 | 检查 entrypoint、可执行位、镜像架构 |

**探针误杀**是"Running 但不 Ready"的常见原因：`livenessProbe` 的 `initialDelaySeconds` 太短，应用还在初始化就被重启，形成循环。检查 `describe` 里的 `Liveness probe failed` 事件。

## 一份可直接照做的排查脚本

```bash
POD=<pod-name>
kubectl get pod $POD -o wide
kubectl describe pod $POD | sed -n '/Events:/,$p'
kubectl logs $POD --tail=80 2>/dev/null || true
kubectl logs $POD --previous --tail=80 2>/dev/null || true
kubectl get events --sort-by=.lastTimestamp | tail -20
```

顺序固定，先状态、再事件、再日志、最后看节点侧（`journalctl -u kubelet`、`docker/containerd` 日志）。**不要一上来就重建 Pod**——重建会丢掉现场。

> 判断口诀：**Pending 看调度，Creating 看网络与存储，Pull 看仓库与凭据，Crash 看日志与退出码，NotReady 看探针。**
