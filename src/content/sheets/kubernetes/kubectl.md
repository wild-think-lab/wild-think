---
title: kubectl 速查
summary: 按场景组织：看状态、查日志、进容器、排 Pending/CrashLoop、改配置、做回滚、抓资源与事件，常用别名与输出格式化一并给。
group: Kubernetes
order: 4
tags: [Kubernetes, kubectl, 排障]
---

## 先配上这几条别名

```bash
alias k=kubectl
alias kg='kubectl get'
alias kd='kubectl describe'
alias kl='kubectl logs -f --tail=200'
alias kx='kubectl exec -it'
complete -F _kubectl k        # 补全（bash）
```

## 看状态

```bash
k get pods -A -o wide
k get pods -o wide --sort-by=.status.startTime
k get deploy,sts,ds -A
k get events -A --sort-by=.lastTimestamp | tail -40
k get nodes -o wide
k top pods --sort-by=memory | head
k top nodes
```

查"为什么没起来"永远先 `describe`，Events 段比容器日志更有信息量。

## 日志与进容器

```bash
k logs deploy/api --tail=200 -f
k logs pod-x -c init-container          # 多容器指定
k logs pod-x --previous                 # 上一个已死容器的日志（CrashLoop 关键）
k exec -it pod-x -- sh
k exec -it pod-x -- curl -sv localhost:8080/healthz
k cp pod-x:/tmp/dump.txt ./dump.txt
```

**`--previous` 是 CrashLoopBackOff 的救命参数**，很多人不知道容器重启后日志就没了。

## Pending / CrashLoop / OOM

```bash
# Pending
k describe pod pod-x | sed -n '/Events/,$p'
k get pod pod-x -o jsonpath='{.status.conditions[?(@.type=="PodScheduled")].message}'

# CrashLoop
k logs pod-x --previous
k get pod pod-x -o jsonpath='{.status.containerStatuses[*].lastState.terminated}'

# OOMKilled
k get pod pod-x -o jsonpath='{.status.containerStatuses[*].lastState.terminated.reason}'
```

退出码含义：

| 码 | 含义 |
| --- | --- |
| 0 | 正常退出（但如果不是预期，说明进程自己结束了） |
| 1 | 应用报错 |
| 137 | 被 SIGKILL，常见于 OOMKilled |
| 143 | SIGTERM，优雅退出没走完 |
| 126/127 | 命令不可执行 / 找不到命令 |

## 改配置与回滚

```bash
k set image deploy/api api=registry/api:1.4.2
k rollout status deploy/api
k rollout history deploy/api
k rollout undo deploy/api --to-revision=3
k scale deploy/api --replicas=6
k edit svc/api
k patch deploy/api -p '{"spec":{"template":{"spec":{"containers":[{"name":"api","resources":{"limits":{"memory":"1Gi"}}}]}}}}'
```

`kubectl edit` 改的是集群里的活对象，**不会回写到 Git**。真正的做法是改清单再 apply。

## 资源与网络

```bash
k get all -n ns
k get endpoints api -o wide
k get svc api -o jsonpath='{.spec.clusterIP}{"\n"}'
k get ingress -A
k port-forward svc/api 8080:80
k run tmp --rm -it --image=curlimages/curl --restart=Never -- sh
```

临时排查用 `k run --rm -it` 起个干净容器，比在业务 Pod 里装工具干净得多。

## 看对象细节

```bash
k get pod pod-x -o yaml
k get pod pod-x -o jsonpath='{.spec.nodeName}'
k get pod -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,NODE:.spec.nodeName,IP:.status.podIP'
k explain pod.spec.containers.resources --recursive
k api-resources | grep -i secret
```

`kubectl explain` 是离线的字段字典，比搜索引擎快。

## 集群与上下文

```bash
k config get-contexts
k config use-context prod
k config view --minify
k get ns
k auth whoami          # 部分版本
k cluster-info
```

**误操作的最大来源是 context 用错**。生产环境建议 `kubectl config rename-context` 改成醒目名字，或在提示符里显示当前 context。

## 清理

```bash
k delete pod pod-x --grace-period=0 --force     # 卡在 Terminating 时
k delete ns old-ns --timeout=60s
k get pv | grep Released
```

`--force` 只删 API 里的记录，真实进程可能还在节点上跑（孤儿容器）。能等就等。
