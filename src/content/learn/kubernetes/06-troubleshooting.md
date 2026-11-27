---
title: 第 6 章 · 排障五步法：从 Pod 起不来到底层网络
module: 进阶篇
summary: 一套固定顺序：看状态 → 看事件 → 看日志 → 进容器 → 查下层。每一层给操作与判读标准，覆盖 Pending、CrashLoop、ImagePull、OOM 四大类。
minutes: 25
---

### 先建立顺序感

排障最怕"想到哪查到哪"。固定五步，逐层往下：

```
① 状态（kubectl get）→ ② 事件（describe）→ ③ 日志（logs）
→ ④ 进容器（exec）→ ⑤ 查下层（节点/网络/存储）
```

80% 的问题在 ①②③ 就能定位。

### ① 状态：先看清症状

```bash
kubectl get pods -o wide
kubectl get pods -o wide --sort-by=.status.startTime
```

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| Pending | 没被调度 | 看 describe 的 Events |
| ContainerCreating | 调度了，正在建 | 看卷挂载与镜像拉取 |
| ImagePullBackOff | 拉不到镜像 | 看镜像名/密钥/仓库 |
| CrashLoopBackOff | 反复崩溃 | 看 `logs --previous` |
| Running 但 READY 0/1 | 探针不过 | 看探针配置与容器内健康 |
| Terminating 卡住 | 优雅退出超时 | 看 preStop 与进程对 SIGTERM 的处理 |
| OOMKilled | 内存超限 | 加 limit 或查内存泄漏 |

### ② 事件：最有信息量的一步

```bash
kubectl describe pod <pod> | sed -n '/Events/,$p'
```

判读：

- `0/3 nodes are available: 3 Insufficient cpu` → 资源不够，加 requests 或加节点。
- `no nodes match node selector` / `taint ... untolerated` → 亲和或污点冲突。
- `persistentvolumeclaim not found` → PVC 名写错或还没 Bound。
- `failed to pull image ... unauthorized` → 拉取密钥缺失。
- `Back-off restarting failed container` → 容器启动即退出，去看日志。

### ③ 日志：区分本容器与 init 容器

```bash
kubectl logs <pod> -c <container> --tail=200
kubectl logs <pod> --previous            # 上一次崩溃的日志
kubectl logs <pod> -c init-db            # init 容器
```

`--previous` 是 CrashLoop 的关键：容器重启后当前日志是空的（新进程还没输出），上一次的日志才有崩溃原因。

日志里找什么：**启动失败的第一行错误**，而不是最后一行。常见的是"配置文件读取失败""连不上数据库""端口被占用"。

### ④ 进容器：没有工具怎么办

```bash
kubectl exec -it <pod> -- sh
# 进去后看：
ss -lntp                # 端口有没有监听（很多镜像没有 ss，用 netstat 或 /proc）
cat /etc/resolv.conf
curl -sv localhost:8080/healthz
ls -l /var/lib/app       # 卷挂载对不对
```

distroless 镜像没有 shell，改用临时容器（Ephemeral Container）：

```bash
kubectl debug -it <pod> --image=nicolaka/netshoot --target=<container>
```

或者直接在同命名空间起一个网络调试 Pod：

```bash
kubectl run tmp --rm -it --image=nicolaka/netshoot --restart=Never -- sh
```

### ⑤ 查下层：节点、网络、存储

```bash
kubectl describe node <node>          # Allocatable、压力、事件
kubectl get events -A --sort-by=.lastTimestamp | tail -30
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50
```

节点层常见：

- `DiskPressure` / `MemoryPressure`：节点资源紧张，Pod 会被驱逐。
- `NotReady`：kubelet 或容器运行时挂了，`journalctl -u kubelet`。
- 时间不同步：证书校验失败，Pod 起不来。

网络层常见：

- Pod 之间不通 → CNI 问题（`kubectl get pods -n kube-system | grep -E 'calico|flannel|cilium'`）。
- 解析失败 → CoreDNS（`nslookup kubernetes.default` 测）。
- 出集群不通 → 节点 NAT/路由。

### 四类高频故障的完整处置

**Pending**

```bash
kubectl describe pod <pod> | grep -A5 Events
kubectl describe node <node> | grep -A3 Allocatable
```

处置：加节点、降 requests、改亲和、加 toleration、先建 PVC。

**CrashLoopBackOff**

```bash
kubectl logs <pod> --previous
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[*].lastState.terminated.reason}'
```

处置：修配置、补环境变量、改启动命令、确认依赖可达。**改完 `kubectl rollout restart` 立刻重试**，不必等退避。

**ImagePullBackOff**

```bash
kubectl describe pod <pod> | grep -i 'pull'
```

处置：确认镜像 tag 存在（别用不存在的 `latest`）、补 `imagePullSecrets`、检查仓库网络与证书。

**OOMKilled**

```bash
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[*].lastState.terminated.reason}'
kubectl top pod <pod>
```

处置：调大 `limits.memory`；Java 应用同时设 `-XX:MaxRAMPercentage=75`；Go 设 `GOMEMLIMIT`；排查是否内存泄漏（RSS 单调上涨）。

### 一个提效习惯：把常用诊断写成一行

```bash
kubectl get pod <pod> -o wide; \
kubectl describe pod <pod> | sed -n '/Events/,$p'; \
kubectl logs <pod> --tail=50
```

登机器先跑这一串，比逐条敲快得多。
