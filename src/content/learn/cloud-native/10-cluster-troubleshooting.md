---
title: 第 10 章 · 集群侧排障：Pod 起不来与"都正常但业务不通"
module: 进阶篇
summary: Pod 状态机与对应原因、Service/Ingress 链路、节点与调度问题、五个"describe 看不出来"的排查手段。
minutes: 50
---

### Pod 状态机

```
Pending            调度没完成（资源/亲和/卷）
ContainerCreating  拉镜像/挂卷/网络
Running            正常
CrashLoopBackOff   启动即退出（看日志与退出码）
ImagePullBackOff   镜像拉不下来
OOMKilled          被内存限制杀
Evicted            节点资源压力驱逐
```

**"先看状态，再看 Events"** 是最省时间的顺序。

### 三个必看的命令

```bash
kubectl describe pod app-0
kubectl logs app-0 --previous      # 上一次崩溃的日志
kubectl get events -n app --sort-by=.lastTimestamp
```

**`--previous`** 是 CrashLoop 的关键（当前容器可能还没输出就退出）。

### Service 链路的五个断点

```
① Service selector ↔ Pod labels
② targetPort ↔ 容器监听端口
③ Endpoints 是否为空
④ kube-proxy 规则（IPVS/iptables）
⑤ 网络策略（NetworkPolicy）
```

```bash
kubectl get endpointslices -l kubernetes.io/service-name=svc
kubectl get svc svc -o jsonpath='{.spec.ports[0].targetPort}'
```

### Ingress 链路的四个断点

```
① IngressClass 是否存在
② host/path 是否匹配
③ backend service/port 是否正确
④ 入口控制器日志（404/502/503）
```

**"外部 404 但内部 curl 正常"** → host 或 path 不匹配。

### 节点与调度

```bash
kubectl describe node node-1 | grep -A5 "Allocated resources"
kubectl get pod -o wide | grep Pending
```

**"Pending 但节点有空闲 CPU"** → request 与可分配不一致（预留/DaemonSet 占用）。

### 五个"describe 看不出来"

**① 应用日志在文件里**

```
用 kubectl exec 去看 /var/log/app
```

**② 上一次崩溃的日志**

```
--previous
```

**③ 网络问题**

```
netshoot + 两端抓包
```

**④ 存储挂载慢**

```
describe 只显示"挂载中"，要看 CSI 日志
```

**⑤ 控制器层面的问题**

```
Deployment 卡在 Progressing → 看 ReplicaSet 事件
```

### 本章检查清单

```
□ 会读 Pod 状态机
□ 会用 --previous
□ 会看 EndpointSlice
□ 会核对 targetPort
□ 会看 Ingress 控制器日志
□ 会算节点可分配资源
□ 有 netshoot 镜像
□ 有 CSI 日志采集
□ 有"排障五步"的固定顺序
□ 有把案例写进 runbook
```
