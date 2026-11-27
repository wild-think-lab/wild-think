---
title: Operator 与 CRD：把人的运维知识写成控制器
description: CRD 与控制器的最小实现、Reconcile 的"期望 vs 实际"循环、finalizer 与状态机、以及"该不该自己写 Operator"的判断。
date: 2026-11-27
tags: [Kubernetes, Operator, CRD, 扩展]
---

### 为什么需要 Operator

K8s 内置的对象（Deployment、StatefulSet）能表达"跑起来"，但表达不了"如何运维一套有状态系统"：

- 主从切换、备份、扩缩容、版本升级要按顺序做。
- 每一步的前置条件与失败恢复都很特殊。

Operator = **CRD（自定义资源）+ 控制器（把它收敛到期望状态）**。

```
你声明：MyDB 有 3 个副本、每天 2 点备份
控制器：持续检查实际状态，缺什么补什么
```

### CRD 的最小定义

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: mydbs.example.com
spec:
  group: example.com
  names:
    kind: MyDB
    plural: mydbs
    singular: mydb
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
            required: [replicas, image]
            properties:
              replicas:     { type: integer, minimum: 1, maximum: 5 }
              image:        { type: string }
              storageSize:  { type: string, default: "10Gi" }
          status:
            type: object
            properties:
              ready:     { type: boolean }
              endpoints: { type: array, items: { type: string } }
    subresources:
      status: {}          # 允许更新 status 子资源
    additionalPrinterColumns:
    - name: Replicas
      type: integer
      jsonPath: .spec.replicas
    - name: Ready
      type: boolean
      jsonPath: .status.ready
```

三个要点：

1. **schema 要写校验**（`required`、`minimum`），否则用户可以填任何垃圾。
2. **`subresources.status`**：让控制器能单独更新状态，不与 spec 冲突。
3. **`additionalPrinterColumns`**：`kubectl get mydb` 才有可读的列。

### 控制器的核心：Reconcile 循环

```go
func (r *MyDBReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var db examplev1.MyDB
    if err := r.Get(ctx, req.NamespacedName, &db); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // ① 期望状态：spec.replicas
    desired := int(*db.Spec.Replicas)

    // ② 实际状态：当前 StatefulSet 的副本数
    var sts appsv1.StatefulSet
    err := r.Get(ctx, req.NamespacedName, &sts)
    if apierrors.IsNotFound(err) {
        return ctrl.Result{}, r.createStatefulSet(ctx, &db)
    }

    actual := int(*sts.Spec.Replicas)
    if actual != desired {
        sts.Spec.Replicas = pointer.Int32(int32(desired))
        if err := r.Update(ctx, &sts); err != nil {
            return ctrl.Result{}, err
        }
        return ctrl.Result{Requeue: true}, nil
    }

    // ③ 更新 status
    db.Status.Ready = sts.Status.ReadyReplicas == desired
    _ = r.Status().Update(ctx, &db)
    return ctrl.Result{}, nil
}
```

三条纪律：

1. **Reconcile 必须幂等**：会被反复调用（事件、重试、定期 resync）。
2. **不要在 Reconcile 里做长阻塞操作**（超过几十秒的等待应拆成独立的 Job 或状态机）。
3. **尽量只"读实际 + 写期望"**，不要保存中间状态到内存（控制器随时可能重启）。

### 状态机与 finalizer

有状态系统的操作通常要按顺序：`创建 → 初始化 → 主从配置 → 就绪`。

用 `status.phase` 表达：

```go
switch db.Status.Phase {
case "":                 // 初始
    createStatefulSet()
    db.Status.Phase = "Initializing"
case "Initializing":
    if stsReady() { db.Status.Phase = "Ready" }
case "Ready":
    if backupDue() { /* 触发备份 Job */ }
}
```

**finalizer**：删除时要先做清理（如先做一次备份、先摘流量）。

```go
const finalizer = "example.com/mydb-cleanup"

if db.DeletionTimestamp != nil {
    if contains(db.Finalizers, finalizer) {
        doBackup(ctx, &db)                     // 清理动作
        db.Finalizers = remove(db.Finalizers, finalizer)
        _ = r.Update(ctx, &db)
    }
    return ctrl.Result{}, nil
}
```

没有 finalizer，删除 CR 会直接丢掉对象，底层资源（PV、外部实例）变成孤儿。

### 事件与限流

```go
func (r *MyDBReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&examplev1.MyDB{}).
        Owns(&appsv1.StatefulSet{}).      // 拥有关系：STS 变化也触发
        WithOptions(controller.Options{MaxConcurrentReconciles: 2}).
        Complete(r)
}
```

`Owns()` 很重要：只有 Owns 了它管理的资源，资源变更才会触发 Reconcile。否则会出现"手动删了 StatefulSet，控制器不知道"。

### 该不该自己写

| 条件 | 结论 |
| --- | --- |
| 官方/社区已有 Operator（如 postgres-operator、redis-operator） | 直接用 |
| 只是"部署 + 配置"，无复杂运维流程 | 用 Helm，不需要 Operator |
| 有"必须按顺序执行的运维动作"，且人工执行易错 | 值得写 |
| 团队没有 Go/K8s 控制器经验 | 先写脚本/Job，别硬上 Operator |

**Operator 的成本不在写，而在长期维护**（版本升级、API 兼容、边界场景）。

### 调试手段

```bash
# 看 CR 与状态
kubectl get mydb -o yaml
kubectl describe mydb sample

# 看控制器日志
kubectl logs -n ops deploy/mydb-operator -f

# 触发一次强制 reconcile（改一个 annotation 即可）
kubectl annotate mydb sample force-reconcile=$(date +%s) --overwrite
```

### 常见坑

1. **忘了 RBAC**：控制器要读写它管理的资源，需要对应的 ClusterRole。
2. **status 更新冲突**：用 `Status().Update()`，不要用 `Update()` 改 status。
3. **CRD 版本变更不兼容**：v1 → v1beta1 之类的迁移要靠 conversion webhook。
4. **没有 leader election**：多副本控制器会同时 reconcile，产生写冲突。
