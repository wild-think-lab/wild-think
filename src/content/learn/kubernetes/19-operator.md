---
title: Operator 与有状态服务：把运维知识写成代码
module: 进阶篇
summary: CRD + Controller 的模型、Reconcile 与 finalizer、状态与条件、用现成 Operator 管数据库，五个"上了 Operator 更不敢动"的原因。
minutes: 50
---

### Operator 是什么

```
CRD：自定义资源（如 kind: PostgresCluster）
Controller：监听这些资源，把实际状态收敛到期望状态
Operator = CRD + Controller + 领域知识
```

**判据**：需要"多步骤、有顺序、要判断"的运维逻辑（备份、扩缩、故障转移）才值得做成 Operator。

### CRD 最小示例

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: webapps.example.com }
spec:
  group: example.com
  scope: Namespaced
  names: { kind: WebApp, plural: webapps, singular: webapp }
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
              properties:
                replicas: { type: integer, minimum: 1 }
                image: { type: string }
```

### Reconcile 循环（核心思想）

```go
func (r *WebAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var app examplev1.WebApp
    if err := r.Get(ctx, req.NamespacedName, &app); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }
    // 期望：Deployment 存在且副本数 = spec.replicas
    // 实际：读当前 Deployment，对比后修正（幂等）
    return ctrl.Result{}, nil
}
```

**关键原则**：

```
① 幂等（重复执行结果一致）
② 声明式（对比期望与实际，而不是"执行步骤"）
③ 出错返回 error 让它重试（不要自己 sleep 重试）
```

### finalizer（删除时要清理）

```go
if app.DeletionTimestamp != nil {
    // 备份数据 / 摘 DNS / 通知外部系统
    controllerutil.RemoveFinalizer(&app, "example.com/finalizer")
    return ctrl.Result{}, r.Update(ctx, &app)
}
```

**"直接删 CR 就丢数据"** → 没写 finalizer。

### 状态与条件

```go
meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
    Type: "Ready", Status: metav1.ConditionTrue, Reason: "ReplicasAvailable",
})
```

**收益**：`kubectl get webapp` 能直接看出"就绪/原因"，不用翻日志。

### 用现成的 Operator（更常见）

```bash
kubectl apply -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/main/releases/cnpg-1.24.0.yaml
```

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: pg }
spec:
  instances: 3
  storage: { size: 20Gi }
  backup:
    barmanObjectStore:
      destinationPath: s3://backup/pg
```

**收益**：主从、切换、备份、扩缩都由 Operator 处理。

**代价**：出问题时你要懂它的 CR 语义，而不是懂 PostgreSQL 本身。

### 五个"上了 Operator 更不敢动"

**① 不懂它做了什么**

```
以为是黑盒 → 出问题只能重启
```

**② 升级 Operator 带崩 CRD**

```
CRD 版本变更，旧 CR 不兼容
```

**③ 备份是 Operator 的事但没人验证**

```
备份策略配了，恢复从没试过
```

**④ 多 Operator 抢同一资源**

```
两个控制器都改同一个 Deployment → 打架
```

**⑤ 权限过大**

```
Operator 通常 cluster-admin → 被利用即全集群
```

### 检查清单

```
□ 明确"为什么用 Operator"（不是流行）
□ Reconcile 幂等
□ 有 finalizer（删除前清理）
□ 有 Status.Conditions（可观测）
□ CRD 有 schema 校验（minimum/enum）
□ 懂它的关键 CR 字段含义
□ Operator 升级有兼容性检查
□ 备份恢复演练过
□ 不与其它控制器抢资源
□ Operator 权限最小化（namespace 级）
```
