---
title: K8s 排障速查
summary: 按"Pod 起不来、网络不通、服务 502、节点异常、存储挂不上"五类现象直接跳到对应命令，附判断依据。
group: Kubernetes
order: 7
tags: [k8s, 排障, kubectl]
---

## 一、Pod 起不来

```bash
kubectl get pods -A -o wide | grep -v Running
kubectl describe pod <pod> -n <ns>          # 看 Events，90% 的答案在这里
kubectl logs <pod> -n <ns> --previous       # 崩溃前的日志
kubectl get events -n <ns> --sort-by=.lastTimestamp | tail -20
```

按状态对症：

| 状态 | 首查 |
| --- | --- |
| `ImagePullBackOff` | 镜像名/tag 是否存在；`imagePullSecrets` 是否正确；节点能否拉取 |
| `CrashLoopBackOff` | `--previous` 日志；启动命令；配置/密钥挂载 |
| `Pending` | `describe` 看"0/N nodes available"：资源不足 / 污点 / 亲和性 / PVC 未绑定 |
| `CreateContainerConfigError` | ConfigMap/Secret 缺失或 key 名错 |
| `OOMKilled` | `limits.memory` 太小；容器内真实内存用量 |
| `Terminating` 卡住 | finalizer；`kubectl patch pod <pod> -p '{"metadata":{"finalizers":null}}'` |

资源是否够：

```bash
kubectl describe node <node> | grep -A5 'Allocated resources'
kubectl get pod <pod> -o jsonpath='{.spec.containers[0].resources}'
```

## 二、网络不通

```bash
# 1. 从 Pod 内测（用临时容器或 exec）
kubectl exec -it <pod> -- sh -c 'getent hosts svc; nc -zv svc 80'

# 2. DNS 是否正常
kubectl run -it --rm dns-test --image=busybox --restart=Never -- nslookup kubernetes.default

# 3. Service 有没有 Endpoints
kubectl get endpoints <svc> -n <ns>
kubectl get endpointslice -n <ns> -l kubernetes.io/service-name=<svc>

# 4. Service 端口 vs 容器端口
kubectl get svc <svc> -o yaml | grep -A5 ports
kubectl get pod <pod> -o jsonpath='{.spec.containers[*].ports}'
```

**Endpoints 为空**的四个原因：

```
① selector 标签不匹配（最常见）
② Pod 未 Ready（探针失败）
③ 命名空间不对
④ Pod 在 Terminating
```

## 三、访问返回 502 / 503

```bash
# Ingress → Service → Pod 逐层看
kubectl describe ingress <ing> -n <ns>       # 看 Backends 与 Events
kubectl get endpoints <svc> -n <ns>
kubectl logs -n ingress-nginx deploy/ingress-nginx-controller | tail -30
```

| 现象 | 原因 |
| --- | --- |
| 502 | 上游 Pod 拒绝连接（端口错、进程未起、探针过松） |
| 503 | 无可用 Endpoints |
| 404 | 路径/rewrite 配置错，或 host 不匹配 |
| 504 | 上游超时（`proxy-read-timeout` 或后端慢） |

## 四、节点异常

```bash
kubectl get nodes
kubectl describe node <node> | grep -A8 Conditions
kubectl top node                              # 需要 metrics-server
# 节点上
systemctl status kubelet containerd
journalctl -u kubelet -n 100 --no-pager | grep -iE 'error|fail'
df -h; df -i; free -m
```

| 现象 | 首查 |
| --- | --- |
| `NotReady` | 磁盘/inode 满、内存耗尽、containerd 挂、时钟漂移 |
| `DiskPressure` | `df -h` 根分区；kubelet 驱逐阈值（默认 10%） |
| Pod 被驱逐 | `kubectl describe pod` 看 `Reason: Evicted` |
| 调度不上 | 污点 `kubectl describe node | grep Taints` |

## 五、存储挂不上

```bash
kubectl get pvc -A
kubectl describe pvc <pvc> -n <ns>            # Events 里通常直接说明原因
kubectl get pv
kubectl get sc
```

| 状态 | 原因 |
| --- | --- |
| `Pending`（PVC） | StorageClass 不存在 / 无匹配 PV / provisioner 未运行 |
| `Pending`（Pod） | PVC 未 Bound，或多节点挂载冲突（RWO） |
| `Lost` | 底层存储被删 |
| 挂载超时 | NFS/Ceph 服务端不可达；`mountOptions` 错 |

## 六、常用"一把梭"

```bash
# Pod 里没有 shell 时用临时容器
kubectl debug -it <pod> --image=nicolaka/netshoot --target=<container>

# 看 Pod 重启历史与上次退出码
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[*].restartCount}'
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[*].lastState}'

# 强制删除卡住的 Pod
kubectl delete pod <pod> --grace-period=0 --force

# 事件全量按时间排序（跨命名空间）
kubectl get events -A --sort-by=.lastTimestamp | tail -30

# 资源用量排行
kubectl top pod -A --sort-by=memory | head -20
```

## 七、判断顺序（背下来）

```
① kubectl get pods → 状态是什么
② kubectl describe → Events 说了什么
③ kubectl logs（含 --previous）→ 应用说了什么
④ 网络：Endpoints 在不在
⑤ 节点：资源、污点、kubelet
⑥ 存储：PVC 绑定状态
```
