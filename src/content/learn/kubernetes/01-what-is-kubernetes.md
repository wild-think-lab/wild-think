---
title: 第 1 章 · Kubernetes 到底解决了什么问题
module: 入门篇
summary: 从"三台机器手工部署"讲到编排：调度、自愈、滚动更新、声明式，先把"为什么需要它"想清楚，再动手。
minutes: 18
---

### 先用一句话说清

Kubernetes 是**一台"集群操作系统"**：你告诉它"我要 3 个副本、每个 1 核 2G、跑这个镜像"，它负责找机器、拉镜像、启动、监控、坏了重启、升级时滚动替换。

### 没有 K8s 的时候怎么干

假设你有 3 台机器、一个应用、一套配置：

```bash
# 手工部署的典型剧本
ssh web1; git pull; systemctl restart app
ssh web2; git pull; systemctl restart app
ssh web3; git pull; systemctl restart app
```

这套剧本的问题：

1. **不知道谁成功了**：第三条命令失败，另外两条已经重启完，状态不一致。
2. **配置散落**：每台机器的 `/etc/app/config.yml` 靠人工同步，总有一台不一样。
3. **故障不自愈**：进程挂了要么有人发现，要么等用户投诉。
4. **扩缩容靠手**：从 3 台扩到 5 台，要装环境、改 Nginx upstream、改监控。
5. **升级有中断**：三台一起重启，服务直接不可用。

### K8s 用四个概念解决这五件事

| 概念 | 解决什么 |
| --- | --- |
| **Pod** | 最小调度单位，一个或多个容器共享网络与存储 |
| **Deployment** | 声明"要几个副本、用什么镜像"，负责滚动更新与自愈 |
| **Service** | 给一组 Pod 一个稳定的虚拟 IP 与 DNS 名 |
| **Controller** | 持续比对"期望状态"与"实际状态"，不一致就拉平 |

关键在最后一个：**声明式 + 控制器循环**。

你说"我要 3 个副本"，K8s 里的 `ReplicaSet` 控制器就会一直盯着，少一个就补一个，多一个就删一个。这就是自愈的本质——不是"监控脚本重启进程"，而是"控制器持续收敛"。

### 一次部署实际发生了什么

```
kubectl apply -f deploy.yaml
   ↓
API Server 收到请求，写入 etcd
   ↓
Deployment 控制器创建 ReplicaSet（期望 3 个 Pod）
   ↓
ReplicaSet 控制器创建 3 个 Pod 对象
   ↓
调度器为每个 Pod 选择节点（看 requests 与约束）
   ↓
目标节点的 kubelet 拉镜像、创建容器、上报状态
   ↓
Pod 进入 Running，Service 的 Endpoints 更新
```

理解这条链路，出问题时就知道该看哪一环：Pod 没创建 = 控制器问题；创建了但 Pending = 调度问题；调度了但起不来 = kubelet/镜像问题。

### 它不是万能的

三种情况不该上 K8s：

1. **只有一台机器、一个应用**：Docker Compose 就够，K8s 的复杂度是纯负担。
2. **团队没有运维能力**：K8s 出问题需要懂网络、存储、调度，学习曲线很陡。
3. **业务对延迟极敏感且无状态需求**：Serverless 或裸机可能更简单。

它适合：多服务、要多环境、要弹性伸缩、要有发布流程的场景。

### 本章要建立的心智模型

```
期望状态（YAML）→ 控制器循环 → 实际状态（集群）
```

后面每一章都在讲"某个对象的期望状态怎么写、控制器怎么实现它"。带着这个模型往下学，比记命令有用得多。

### 动手（可选）

如果本地有 Docker，用 kind 起一个单节点集群：

```bash
kind create cluster --name lab
kubectl cluster-info
kubectl get nodes
kubectl get pods -A
```

看到 `node/lab-control-plane Ready` 就说明集群活了。后面所有实验都可以在这个集群里做，删掉重建只要 `kind delete cluster`。
