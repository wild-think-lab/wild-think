---
title: GitOps 与 ArgoCD：把"谁改了集群"变成一次 commit
description: GitOps 的四条原则、ArgoCD 的 Application 与同步机制、Kustomize 与 Helm 怎么选、多环境目录怎么排、以及它解决不了的三件事。
date: 2023-01-18
tags: [GitOps, ArgoCD, Kubernetes, 交付, DevOps]
---

### GitOps 其实就四句话

1. **声明式**：集群的期望状态写在 Git 里（YAML）。
2. **唯一来源**：集群里的一切都从 Git 来，手工 `kubectl edit` 出来的东西会被覆盖。
3. **自动同步**：由代理持续比对"Git 里的"和"集群里的"，不一致就拉平。
4. **可审计**：谁、什么时候、改了什么，`git log` 全都有。

这解决的是运维里最难回答的问题：**"这个配置是谁改的？"** 有了 GitOps，答案是 commit sha。

### ArgoCD 的三个对象

- **Application**：一份 CRD，描述"哪个 Git 路径 → 同步到哪个集群/命名空间"。
- **Repo**：Git 仓库地址与凭据。
- **Sync Policy**：自动同步、自愈（selfHeal）、允许 prune 删除多余资源。

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: order-api-prod
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/acme/gitops-config.git
    targetRevision: main
    path: apps/order-api/overlays/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: prod
  syncPolicy:
    automated:
      prune: true          # Git 删了，集群也删
      selfHeal: true       # 有人手工改了，自动改回去
      allowEmpty: false    # 目标目录为空时报错，防止误清空
    syncOptions:
      - CreateNamespace=true
    retry:
      limit: 5
      backoff: { duration: 5s, factor: 2, maxDuration: 3m }
```

`selfHeal: true` 是 GitOps 的灵魂：有人在集群里 `kubectl edit` 加了个 sidecar，几分钟后就消失了，改了也没用——这会让团队真正把改动写回 Git。

### 目录怎么排

一个经过验证的排法：

```
gitops-config/
├── clusters/
│   ├── dev/
│   ├── staging/
│   └── prod/            # 每个集群一个目录，里面是"装了哪些 app"的清单
├── apps/
│   └── order-api/
│       ├── base/        # 公共部分：Deployment、Service、HPA
│       └── overlays/
│           ├── dev/     # kustomization.yaml + 副本数/镜像 tag patch
│           ├── staging/
│           └── prod/
└── infra/               # ingress-nginx、cert-manager、监控等平台组件
```

镜像 tag 的更新有两种做法：

- **CI 直接改 Git**（`kustomize edit set image`），产生一个"发布 commit"，回滚就是 revert 这个 commit；
- **ArgoCD Image Updater** 监控镜像仓库，自动写回 Git。

前者可控性最高，推荐。

### Kustomize 还是 Helm

| | Kustomize | Helm |
| --- | --- | --- |
| 定位 | 给 YAML 打补丁 | 模板 + 打包发布 |
| 多环境 | base + overlay，diff 很直观 | values 文件 |
| 学习成本 | 低 | 中（模板函数容易绕晕） |
| 适合 | 自己写的应用、少量差异 | 第三方组件（如 ingress、prometheus） |

两者可以叠加：`helm template` 输出再交给 Kustomize patch。ArgoCD 原生支持两者，`path` 指向 `kustomization.yaml` 或含 `Chart.yaml` 的目录都行。

### 它解决不了的三件事

1. **Secret 不能进 Git 明文**。方案：Sealed Secrets、SOPS + age、External Secrets Operator 对接 Vault。最省事的是 External Secrets。
2. **首次安装还得有人装**。ArgoCD 自己得先 apply 一次（bootstrap），之后才能"声明式自举"。
3. **数据库迁移不在 GitOps 范围内**。K8s 能管 Pod，管不了"执行某条 SQL"。这类需要 Job + initContainer，或者交给应用启动时迁移，并保证可重入。

### 排障：为什么显示 OutOfSync

```bash
argocd app get order-api-prod
argocd app diff order-api-prod        # 直接看差异，最有用的命令
argocd app sync order-api-prod --dry-run
argocd app history order-api-prod
```

`OutOfSync` 常见原因：

- 集群里有人手工改了（`selfHeal` 会拉回，但在此之前会闪 OutOfSync）。
- 默认值漂移：`spec.replicas` 没写但被 HPA 改过。
- 镜像 tag 是可变 tag（`latest`），ArgoCD 认为"Git 里写的是 latest，集群里也是 latest"，但实际内容变了。**用 digest 或不可变 tag 才能避免这个坑。**
- Webhook 没配，只能靠 3 分钟的轮询周期发现。

### 上线顺序建议

1. 先把清单从"手写 kubectl apply"迁到 Git 目录结构（不改流程）。
2. 接 ArgoCD，只做"只读 + 手动 sync"，确认能同步成功。
3. 打开 `automated`，但先关 `prune`，观察一周。
4. 最后开 `selfHeal` 与 `prune`。

一次打开全部功能，最容易在某次目录调整时把生产资源全删掉。

### 一句话总结

GitOps 不是"更高级的 CI"，而是**把集群状态变成可评审、可回滚、可审计的代码**。
