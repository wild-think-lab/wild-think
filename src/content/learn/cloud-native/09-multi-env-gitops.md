---
title: 第 9 章 · 多环境与多集群：Argo CD 怎么管
module: 进阶篇
summary: 环境隔离的三种方式、Application/ApplicationSet、同步策略与权限、五个"GitOps 上线后更乱"的原因。
minutes: 50
---

### 环境怎么隔离

```
① 命名空间隔离（最轻，适合小团队）
② 集群隔离（生产/预发各自独立，最稳）
③ 项目隔离（Argo CD Project 限制"能部署到哪"）
```

**"测试和生产同一个集群"** → 一次误操作可能影响生产（至少要做 Project 限制）。

### 一个 Application

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: {name: app-prod, namespace: argocd}
spec:
  project: app
  source:
    repoURL: https://github.com/org/deploy
    path: apps/app/overlays/prod
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: app
  syncPolicy:
    automated: {prune: true, selfHeal: true}
    syncOptions: [CreateNamespace=true]
```

**`prune: true`** 会删除"Git 里没有的资源"（要谨慎，配错会删东西）。

### ApplicationSet：一份配置铺多环境

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
spec:
  generators:
  - list:
      elements:
      - {env: dev, cluster: https://dev-api, ns: app-dev}
      - {env: prod, cluster: https://prod-api, ns: app-prod}
  template:
    metadata: {name: 'app-{{env}}'}
    spec:
      source: {repoURL: ..., path: 'apps/app/overlays/{{env}}'}
      destination: {server: '{{cluster}}', namespace: '{{ns}}'}
```

**"复制粘贴三份 Application"** → 改一次要改三处（迟早漏）。

### 同步策略

```
自动同步（automated）+ selfHeal：偏离即纠正
手动同步：关键环境用"审批"
```

**"生产也全自动"** → 需要配合"deploy 仓库 PR 保护 + 审批"。

### 权限（Project 很重要）

```yaml
spec:
  destinations:
  - {namespace: 'app-*', server: 'https://kubernetes.default.svc'}
  sourceRepos: ['https://github.com/org/deploy']
  clusterResourceWhitelist: []
```

**"所有人都能部署到任意 ns"** → GitOps 失去"边界"。

### 五个"GitOps 上线后更乱"

**① 有人在集群里手改**

```
selfHeal 会改回去（或不同步）→ 冲突
```

**② 镜像 tag 用 latest**

```
Git 里没变，但集群里在变（不可追溯）
```

**③ 配置散落多个仓库**

```
app 代码 + deploy 仓库 + helm 仓库 → 三个 PR 才能上线
```

**④ 密钥进 Git**

```
Sealed Secrets 或 ESO 才能兼顾 GitOps 与安全
```

**⑤ 没有回滚演练**

```
revert commit 会不会真的回滚？（有状态服务可能不会）
```

### 本章检查清单

```
□ 环境隔离方式明确
□ 用 ApplicationSet 管理多环境
□ prune 策略明确（关键环境慎用）
□ Project 限制目标 ns/cluster
□ 生产有审批或 PR 保护
□ 镜像用 digest/tag（不用 latest）
□ 密钥用 Sealed/ESO
□ 有人手改的检测（selfHeal 或告警）
□ 回滚演练过
□ 部署历史可追溯
```
