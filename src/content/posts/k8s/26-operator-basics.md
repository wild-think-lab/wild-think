---
title: 写一个 Operator：CRD 到 reconcile 的最小闭环
description: 声明式控制循环、CRD 设计要点、状态与事件，以及五个"operator 上线就疯狂重建"的原因。
date: 2026-11-27
tags: [Kubernetes, Operator, Go]
---

### 一句话原理

```
用户声明"期望状态"（CRD） → operator 对比"实际状态" → 不断调整到一致
```

**"reconcile 是幂等的、可重复调用的函数"** —— 这是全部设计的核心。

### CRD 设计要点

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: apps.example.com
spec:
  group: example.com
  names: {kind: App, listKind: AppList, plural: apps, singular: app}
  scope: Namespaced
  versions:
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            required: [image, replicas]
            properties:
              image: {type: string}
              replicas: {type: integer, minimum: 1, maximum: 10}
          status:
            type: object
            properties:
              readyReplicas: {type: integer}
              phase: {type: string}
    subresources:
      status: {}
```

**三个要点**：

```
① spec 放"用户想要的"，status 放"实际情况"
② subresources.status → 更新 status 不触发 spec 变更
③ 用 minimum/maximum 做校验（比在代码里判断更早失败）
```

### reconcile 的骨架

```go
func (r *AppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var app examplev1.App
    if err := r.Get(ctx, req.NamespacedName, &app); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // 1) 期望的 Deployment
    desired := buildDeployment(&app)

    // 2) 实际的 Deployment
    var cur appsv1.Deployment
    err := r.Get(ctx, types.NamespacedName{Name: desired.Name, Namespace: desired.Namespace}, &cur)
    if apierrors.IsNotFound(err) {
        return ctrl.Result{}, r.Create(ctx, desired)
    }
    if err != nil {
        return ctrl.Result{}, err
    }

    // 3) 不一致就更新
    if !equalSpec(cur.Spec, desired.Spec) {
        cur.Spec = desired.Spec
        return ctrl.Result{}, r.Update(ctx, &cur)
    }

    // 4) 更新 status
    app.Status.ReadyReplicas = cur.Status.ReadyReplicas
    app.Status.Phase = phaseOf(&cur)
    return ctrl.Result{}, r.Status().Update(ctx, &app)
```

**四个关键点**：

```
① NotFound 要 IgnoreNotFound（不是报错）
② 用 Status().Update 更新状态
③ 每步都"检查再动作"（幂等）
④ 返回 error 会触发"指数退避重试"
```

### 五个"operator 上线就疯狂重建"

**① 每次 reconcile 都"删除再创建"**

```
→ 反复重建 Pod（服务抖动）
→ 应该"对比后只改差异"
```

**② 状态写进了 spec**

```
operator 更新 spec 的注解/字段 → 触发自己 → 死循环
→ 状态放 status 子资源
```

**③ 没有"仅比较必要字段"**

```
K8s 会填充默认值（如 strategy）→ 你比较整个 spec → 永远"不一致"
→ 只比较你关心的字段
```

**这是最常见的问题**（默认值导致的无限更新）。

**④ 没处理 finalizer**

```
删除时资源没清理 → 残留（ConfigMap/外部资源）
```

```go
if !app.DeletionTimestamp.IsZero() {
    cleanup(app)
    controllerutil.RemoveFinalizer(&app, "apps.example.com/finalizer")
    return ctrl.Result{}, r.Update(ctx, &app)
}
```

**⑤ 权限过大/过小**

```
过小 → 无法创建 Deployment（一直报错重试）
过大 → 越权操作
→ 用 kubebuilder 生成最小 RBAC
```

### 事件与"触发时机"

```
① 资源变更（watch）→ 入队
② 定时重同步（RequeueAfter）→ 兜底（防止漏事件）
③ 子资源变更（Owns）→ 触发父资源
```

```go
ctrl.NewControllerManagedBy(mgr).
    For(&examplev1.App{}).
    Owns(&appsv1.Deployment{}).
    Complete(r)
```

**"Owns"** 让 Deployment 变化也能触发 App reconcile（非常关键）。

### 一个"能上生产"的最低要求

```
□ 幂等（重复执行结果一致）
□ 有 finalizer（清理）
□ 只比较必要字段
□ 有 RequeueAfter 兜底
□ RBAC 最小
□ 有 condition/status 能反映"为什么没就绪"
□ 有 leader election（多副本）
□ 有 metrics（reconcile 次数/耗时/错误）
```

### 检查清单

```
□ CRD 有 schema 校验（required/min/max）
□ status 子资源开启
□ reconcile 幂等（对比后改差异）
□ NotFound 用 IgnoreNotFound
□ 处理 finalizer
□ 用 Owns 触发子资源变更
□ 有定时重同步
□ RBAC 最小
□ status 反映就绪原因
□ 有 leader election
□ 有 reconcile 指标
```
