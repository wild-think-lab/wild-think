---
title: CKA 备考：考什么、怎么练、哪些坑最容易丢分
description: CKA 的题型与时间分配、必练的十二个场景、kubectl 速度技巧、文档怎么用、以及"能操作但拿不到分"的四个原因。
date: 2026-11-27
tags: [CKA, Kubernetes, 认证, 备考]
---

### 考试形态

- **纯实操**，没有选择题。约 15–20 道题，2 小时。
- 环境是远程的 K8s 集群（多套），每道题在指定 context 里做。
- 可以用官方文档（kubernetes.io），**不能用搜索引擎与个人笔记**。
- 及格线 66%，但每道题有权重差异（有的题 4%，有的 8%）。

关键认知：**时间不是充足的**。平均每题 6–8 分钟，写 YAML 慢一点就做不完。

### 必练的十二个场景

按出题频率排序：

1. **创建 Pod / Deployment / Job / CronJob**（含命令与 args）
2. **ConfigMap 与 Secret 挂载**（env、volume、subPath）
3. **Service 类型切换**（ClusterIP / NodePort）与端口映射
4. **Ingress 规则**（host + path + TLS）
5. **PVC + StorageClass**，StatefulSet 的 volumeClaimTemplates
6. **Deployment 滚动更新与回滚**（`rollout undo`、`history`）
7. **HPA**（用 `kubectl autoscale` 或手写 v2）
8. **NetworkPolicy**（限制同命名空间与跨命名空间流量）
9. **RBAC**（Role + RoleBinding + ServiceAccount，最小权限）
10. **节点维护**：`drain` / `cordon` / `uncordon`，配合 PDB
11. **排障**：Pod Pending / CrashLoop / Service 无 Endpoint / 日志排查
12. **集群组件排障**：kubelet、静态 Pod、CNI

第 9 与第 8 是最容易"做了一半"的题：NetworkPolicy 少写一个 `podSelector` 就等于全通；RBAC 少写 `resources` 就等于没授权。

### 速度技巧

**① 善用命令生成 YAML**

```bash
kubectl create deploy web --image=nginx --dry-run=client -o yaml > d.yaml
kubectl run tmp --image=busybox --dry-run=client -o yaml -- sleep 3600 > p.yaml
kubectl create job hello --image=busybox --dry-run=client -o yaml -- echo hi > j.yaml
```

`--dry-run=client -o yaml` 是考试里最值钱的组合：生成骨架，再改字段。

**② 记 `kubectl explain`**

```bash
kubectl explain pod.spec.containers.securityContext --recursive | head -30
```

不用背字段名，考试时查它比翻网页快。

**③ 别名与补全**

考试环境不一定能改配置，但可以在当次 shell 里：

```bash
alias k=kubectl
export do='--dry-run=client -o yaml'
k create deploy web --image=nginx $do
```

**④ 编辑 YAML 用 vim 的小技巧**

```
:set paste        # 粘贴不自动缩进
=G                # 全文自动缩进（YAML 对齐神器）
```

`=G` 能免掉 80% 的缩进错误。

### 四个最容易丢分的原因

**① context 用错**

每道题开头都会说"在 cluster X 的 context 里操作"。忘了切 context，做在错的集群上，直接 0 分。

```bash
kubectl config use-context cluster2
kubectl config current-context     # 每次做完都回头确认一遍
```

**② 只创建不验证**

题面要求"Pod 处于 Running"，你建完就走了。必须验证：

```bash
kubectl get pod -o wide
kubectl describe pod | tail -10
```

**③ 忘了 namespace**

一半的题指定 namespace。忘了 `-n` 就在 default 里创建，判分脚本找不到。

**④ YAML 缩进错**

`kubectl apply` 报 `error parsing`。用 `=G` 或 `kubectl create ... -o yaml` 生成骨架。

### 排障题的固定套路

考题会给"某个 Pod 起不来，请修复并让它 Running"。

```bash
# 1. 看状态与事件
kubectl get pod -o wide
kubectl describe pod <pod> | tail -20
# 2. 看日志（含上一次）
kubectl logs <pod> --previous
# 3. 看对象定义（是不是字段写错）
kubectl get pod <pod> -o yaml
```

高频原因：

- 镜像名/tag 不存在
- volumeMount 路径与 volume 名不匹配
- 资源 requests 超过节点可分配
- ConfigMap/Secret 名写错
- command 与 args 拼错（注意 command 会覆盖 ENTRYPOINT）

修完记得**验证**：`kubectl get pod` 的 STATUS 是 Running 且 READY 1/1。

### 时间分配建议

```
0–10 分钟：浏览所有题，先做最简单的 3–4 道（拿稳基础分）
10–80 分钟：按顺序做题，卡住超过 8 分钟就跳过
80–110 分钟：回头做跳过的题
110–120 分钟：全部复查（context、namespace、状态）
```

**不要在一道题上死磕**。一道 8% 的题花 25 分钟，等于放弃另外三道。

### 考试环境准备

- 网络稳定、摄像头与麦克风正常（有监考）。
- 桌面干净（监考会要求展示）。
- 提前测试浏览器兼容性（通常要求 Chrome）。
- **不能带笔记**，所以常用命令必须形成肌肉记忆。

### 练法：三周计划

| 周 | 内容 |
| --- | --- |
| 1 | 每天 3 个场景，手写 YAML 不查文档；建 kind 集群练 |
| 2 | 做 2 套模拟题（限时 2 小时），错题重做 |
| 3 | 只练弱项 + 排障题；把 12 个场景各写一遍 |

`kind` 或 `minikube` 足够练大多数场景；NetworkPolicy 与 RBAC 需要真集群（kind 支持）。

### 一句话总结

CKA 考的不是知识广度，而是**在限时环境下把需求准确变成 YAML 并验证**。练"生成骨架 + 验证状态"，比背文档有用得多。
