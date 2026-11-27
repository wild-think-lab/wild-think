---
title: Docker 与 K8s 面试：三个层次答法，别一上来就背组件
description: 面试里"讲讲 Docker 原理"这类问题的失分点不在知识量，而在层次。按结论—原理—追问三层组织答案，20 个高频题的实际考法。
date: 2026-11-19
tags: [面试, Docker, Kubernetes, 云原生]
---

面试官问"讲讲 Docker 和虚拟机的区别"，想听的不是"一个轻一个重"，而是你知不知道这个"轻"轻在哪、代价是什么。

## 一、三层答法是什么

| 层 | 内容 | 时长 |
| --- | --- | --- |
| 结论层 | 一句话给出判断 | 10 秒 |
| 原理层 | 机制、边界、代价 | 60–90 秒 |
| 追问层 | 场景、故障、取舍 | 剩余时间 |

示例（"容器和虚拟机的区别"）：

> **结论**：虚拟机隔离的是硬件，容器隔离的是进程视图；所以容器启动是毫秒级，但内核是共享的。
> **原理**：容器靠 namespace 做视图隔离（pid/net/mnt/uts/ipc/user）、cgroup 做资源限制、rootfs 做文件系统隔离；虚拟机靠 hypervisor 虚拟出完整硬件，跑独立内核。
> **代价**：共享内核意味着内核漏洞是逃逸面，也意味着容器内看到的 `/proc`、内核参数与宿主相关；需要强隔离时用 Kata / gVisor / 独立节点。

## 二、容器部分高频题

**Q：镜像分层是什么，为什么要分层？**

每层是只读的，`COPY`/`RUN` 各产生一层，容器启动时在最上面加一层可写层（overlay2 的 upperdir）。分层让多个镜像共享基础层，节省磁盘与拉取时间；但**可写层的数据在容器删除时消失**，所以需要 volume。

追问"为什么 Dockerfile 里 `RUN apt-get update && apt-get install` 要写在一行"：分层缓存以指令为单位，拆成两行时 `update` 的缓存会让后续安装拿到过期索引。

**Q：容器里 PID 1 有什么特殊？**

PID 1 不处理默认信号、不回收僵尸进程。应用直接作为 PID 1 时，`docker stop` 的 SIGTERM 可能被忽略，10 秒后被 SIGKILL。解法：用 `tini`/`dumb-init` 做 init，或应用自己处理信号并 `wait` 子进程。

**Q：镜像怎么减小？**

多阶段构建（build 阶段带编译器，final 阶段只拷产物）、用 slim/alpine 基础镜像（注意 musl 与 glibc 的兼容性）、合并 `RUN` 减少层数、`.dockerignore` 排除无关文件、清理包管理器缓存。

## 三、K8s 部分高频题

**Q：一个 Pod 从创建到 Running 经历了什么？**

`kubectl apply` → apiserver 写入 etcd → scheduler 绑定 Node → kubelet 收到绑定事件 → 拉镜像 → 创建 sandbox（pause 容器）→ 建网络命名空间 → 启动业务容器 → 探针通过 → Ready。排障时"卡在哪一步"就是这条链。

**Q：Pod 一直 Pending，怎么查？**

`kubectl describe pod` 的 Events 是唯一入口，四类原因：

1. 资源不足（`Insufficient cpu/memory`）→ 看 `kubectl describe node` 的 Allocated；
2. 污点与亲和（`node(s) had untolerated taint`）→ 检查 taint/toleration；
3. PVC 未绑定（`pod has unbound immediate PersistentVolumeClaims`）→ 看 StorageClass、PV 容量与访问模式；
4. 调度器不可用或 Pod 有 `nodeName` 但节点 NotReady。

**Q：Service 是怎么把流量送到 Pod 的？**

Service 有 ClusterIP + Endpoints（或 EndpointSlice），kube-proxy 用 iptables/IPVS 在节点上写转发规则，DNAT 到后端 Pod IP；`type: LoadBalancer` 再多一层云厂商 LB，`NodePort` 则在每个节点开同一端口。

追问"为什么 Service 的 ClusterIP 能 ping 不通但 curl 能通"：ClusterIP 是虚拟 IP，没有实体接口，iptables 只处理 TCP 转发，ICMP 没有对应规则。

**Q：Ingress 和 Service 的区别？**

Service 是四层（IP+端口）负载均衡；Ingress 是七层入口，按 Host/Path 路由到不同 Service，本身需要 Ingress Controller（nginx/traefik）实现。没有 Controller 的 Ingress 资源只是一份配置。

**Q：探针 liveness 和 readiness 用错会怎样？**

- `liveness` 失败 → 重启容器。配置过严（如依赖下游）会导致级联重启风暴；
- `readiness` 失败 → 从 Endpoints 摘除，不重启。依赖未就绪时应该只影响 readiness。

原则：**liveness 只检查"进程自身是否死锁"，readiness 检查"能否接流量"**。启动慢的应用配 `startupProbe`，否则 liveness 会在启动期杀掉进程。

**Q：节点 NotReady 怎么排查？**

顺序：`kubectl describe node` 看 Conditions → 节点上 `systemctl status kubelet` → `journalctl -u kubelet` → 检查容器运行时（`crictl ps`）、磁盘压力（`DiskPressure` 常见于镜像/日志写满）、CNI 插件 Pod 是否正常。

## 四、被追问时最容易被抓住的三点

1. **说"容器就是轻量虚拟机"** —— 直接暴露概念错误；
2. **说"K8s 会自动处理一切"** —— 追问"etcd 挂了会怎样"就答不上；
3. **只背组件名不讲数据流** —— 追问"kube-proxy 用什么模式、规则在哪"立刻卡住。

补救方式：任何组件问题都回到"**谁写、谁读、写在哪**"三问。例如 kube-proxy 写 iptables 规则在节点上，读的是 apiserver 的 Service/EndpointSlice。

## 五、准备方式

- 每题按三层写成 5 行以内的提纲，**只背提纲不背全文**；
- 手上有 2–3 个真实故障案例（Pending、CrashLoopBackOff、ImagePullBackOff、节点 NotReady 各一个），面试官更信案例；
- 命令记最小集：`describe`、`logs`、`exec`、`get events`、`crictl`、`journalctl`。

> 一句经验：**面试答云原生，永远从"这条链路上数据在哪、谁改的"讲起**。组件名谁都能背，能讲清数据流的才算真懂。
