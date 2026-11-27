---
title: kubectl debug：Pod 起不来时怎么进去看
description: 临时容器、节点级调试、网络命名空间共享，以及五个"debug 也进不去"的原因。
date: 2026-11-27
tags: [Kubernetes, 排障, kubectl]
---

### 三种调试目标

```
① Pod 能起但应用有问题 → 临时容器进同一个 Pod
② Pod 起不来（镜像/配置错）→ 复制一份改配置调试
③ 节点本身有问题 → 节点级调试 Pod
```

**"容器里没有 bash/curl"** 是最常见的困境，临时容器正是为此设计的。

### ① 临时容器（ephemeral container）

```bash
kubectl debug -it pod/app-0 --image=nicolaka/netshoot --target=app
```

**特点**：

```
① 共享 Pod 的网络命名空间（能 curl localhost:8080）
② 共享进程命名空间（能看目标进程）
③ 不共享文件系统（各自独立）
```

**"netshoot"** 里带 curl/dig/tcpdump/ss，是排障首选镜像。

**查看共享的文件系统**（需要 volume 挂载）：

```bash
kubectl debug pod/app-0 --image=busybox -it \
  --target=app \
  -- sh -c "ls /proc/1/root/var/log"
```

**`/proc/1/root`** 是目标容器根文件系统的入口。

### ② 复制 Pod 改配置

```bash
kubectl debug pod/app-0 -it --copy-to=app-debug --container=app \
  --image=busybox -- sh
```

**用途**：

```
原 Pod 起不来（镜像拉不到/启动命令错）
→ 复制一份，换镜像/改命令，看能不能起
```

**注意**：

```
copy 的 Pod 会占用资源、可能被调度到别的节点
调试完要删
```

### ③ 节点级调试

```bash
kubectl debug node/worker-1 -it --image=nicolaka/netshoot
```

**特点**：

```
Pod 会挂载节点的 /host
→ 能直接看 kubelet 日志、containerd 状态、节点网络
```

```bash
# 进节点调试 Pod 后
ls /host/var/log
cat /host/var/log/syslog | tail -50
crictl --runtime-endpoint unix:///host/run/containerd/containerd.sock ps -a
```

**"节点上 Pod 全挂"** → 这个方式最直接。

### 常见调试动作

```bash
# 看 DNS
nslookup kubernetes.default
# 看服务能否解析
curl -v http://app.default.svc.cluster.local:8080/healthz
# 看目标端口
nc -zv app 8080
# 抓包（共享网络命名空间时）
tcpdump -i any -nn port 8080
```

**"在临时容器里 curl 通"** → 说明网络没问题，问题在应用内部。

### 五个"debug 也进不去"

**① 节点禁止临时容器**

```
kubelet 的 --enable-debugging-handles 或准入策略阻止
```

**② Pod 的 securityContext 限制**

```
readOnlyRootFilesystem / 非 root / 无 capabilities
→ 临时容器仍能进，但很多命令受限
```

**③ 节点资源不足**

```
临时容器调度不上 → Pending
```

**④ 用了 distroless + 没有 shell**

```
这就是"为什么需要临时容器"的原因（不要在业务镜像里塞 shell）
```

**⑤ 权限不足**

```
RBAC 没有 pods/ephemeralcontainers 权限
```

```bash
kubectl auth can-i create pods/ephemeralcontainers -n app
```

### 三个"不推荐"的做法

```
✗ 给生产镜像加 bash/curl（增大攻击面）
✗ 直接 kubectl exec 到业务容器跑一堆调试工具
✗ 用 privileged 的 debug Pod 挂宿主机根目录（风险极高）
```

**"临时容器"** 比"往镜像里塞工具"安全得多。

### 一个"排障顺序"结合

```
1) kubectl describe pod → Events（镜像/调度/探针）
2) kubectl logs --previous → 崩溃前的日志
3) kubectl debug 临时容器 → 网络/DNS/依赖连通
4) kubectl debug node → 节点层（kubelet/运行时/磁盘）
```

**"先看 Events"** 能解决一半问题。

### 检查清单

```
□ 会用 --target 共享网络/进程
□ 会用 --copy-to 改配置调试
□ 会用 node/ 做节点调试（挂 /host）
□ 有 netshoot 类镜像可用
□ RBAC 允许 ephemeralcontainers
□ 业务镜像保持最小（不塞调试工具）
□ 调试 Pod 用完即删
□ 排障顺序：Events → 日志 → 网络 → 节点
```
