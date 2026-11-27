---
title: GitOps 落地：ArgoCD 从装到用，以及五个会咬人的细节
description: 声明式部署的完整链路、Application/AppProject 的区别、同步策略、多环境管理，以及镜像更新的正确做法。
date: 2026-11-27
tags: [GitOps, ArgoCD, DevOps, Kubernetes]
---

### GitOps 的一句话定义

```
Git 是唯一事实来源（Single Source of Truth）
集群状态 = Git 仓库的镜像
变更 = 提交（PR + review + merge）
```

**它和"CI 直接 kubectl apply"的区别**：

```
CI 推送模式：CI 有集群写权限，改了什么看 CI 日志
GitOps 拉取模式：集群自己来拉，所有变更都有 Git 记录与 review
```

**GitOps 更强的地方在"可审计 + 可回滚"**（`git revert` 就是回滚）。

### 组件分工

```
ArgoCD       ：对比 Git 与集群状态，同步（控制面）
Application  ：一个"要部署什么"的声明（源 + 目标）
AppProject   ：权限边界（哪些仓库、哪些目标 namespace）
ApplicationSet：批量生成多个 Application（多环境/多集群）
```

### 安装

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 拿初始密码
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d

# 端口转发访问
kubectl port-forward svc/argocd-server -n argocd 8080:443
```

**生产建议**：改用 HA 部署（`manifests/ha/`），或至少少于 3 个副本。

### 一个 Application

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: api-prod
  namespace: argocd
  finalizers:
  - resources-finalizer.argocd.argoproj.io   # 删 App 时级联删资源
spec:
  project: default
  source:
    repoURL: https://github.com/org/deploy-repo.git
    targetRevision: HEAD
    path: envs/prod/api
  destination:
    server: https://kubernetes.default.svc
    namespace: prod
  syncPolicy:
    automated:
      prune: true        # 删除 Git 里没有的资源
      selfHeal: true     # 集群被手动改了，自动纠回
    syncOptions:
    - CreateNamespace=true
    retry:
      limit: 3
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

**两个 automated 参数是 GitOps 的灵魂**：

```
prune    ：Git 里删了 → 集群里也删（否则"删不掉"）
selfHeal ：有人手动 kubectl 改 → 自动改回去
```

**但 `prune: true` 有风险**：误删 Git 里的文件会级联删资源。建议先用 `prune: false` 观察。

### 五个会咬人的细节

**① 镜像更新不要"改 tag"**

```
错的：deploy.yaml 里 image: myapp:v1 → 手动改 v1 到 v2
```

**原因**：

```
① 要人改（不自动化）
② 改 tag 无法表达"哪个 commit"
```

**正确做法（三种）**：

```
A. CI 写回 Git（image updater）
   CI 构建完镜像 → 提交一个新 commit 改 image tag → ArgoCD 自动同步

B. ArgoCD Image Updater
   监听镜像仓库的新 tag → 自动改 Application 的 image

C. 用不可变 tag（commit sha）+ CI 写回
```

**推荐 A + C**：CI 写回（可审计），tag 用 sha（可追溯）。

**② `targetRevision` 用分支还是 tag**

```
HEAD / main  ：跟随分支（适合 dev）
v1.2.3       ：固定 tag（适合 prod，变更必须显式）
```

**生产用 tag 或固定 commit**，避免"分支上的一次合入直接上生产"。

**③ Application 放哪**

```
方案 A：Application 也在同一个 Git 仓库（自管理）
方案 B：Application 在单独的 "argocd-config" 仓库
```

**B 更好**：避免"改 App 定义"与"改部署内容"混在一起。

**④ 多环境怎么组织**

```
方式一（推荐）：单仓库多目录
  deploy-repo/
    base/                # 公共（Kustomize base）
    overlays/dev/
    overlays/staging/
    overlays/prod/

方式二：每环境一个分支（不推荐，合并困难）
方式三：每环境一个仓库（管理成本高）
```

**用 Kustomize overlay 是最省事的**：

```yaml
# overlays/prod/kustomization.yaml
resources:
- ../../base
images:
- name: myapp
  newName: registry/myapp
  newTag: "sha-abc123"
```

**⑤ 密钥怎么管**

```
不要把 Secret 明文放 Git
方案：
① Sealed Secrets（加密后提交，集群内解密）
② External Secrets（从 Vault/AWS SM 拉）
③ SOPS + age（文件级加密）
```

**Sealed Secrets 最简单**：

```bash
kubeseal --format yaml < secret.yaml > secret-sealed.yaml
# 提交 secret-sealed.yaml
```

### AppProject：权限边界

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-a
spec:
  sourceRepos:
  - https://github.com/org/team-a-deploy.git
  destinations:
  - namespace: team-a-*
    server: https://kubernetes.default.svc
  clusterResourceWhitelist: []
  namespaceResourceBlacklist:
  - group: ""
    kind: ResourceQuota
```

**意义**：

```
团队 A 只能部署到 team-a-* 命名空间
→ 防止误部署到别人的命名空间（或 prod）
```

**`clusterResourceWhitelist: []`** 表示"不允许创建集群级资源"，是很重要的收紧。

### 同步策略的选择

```
自动同步（automated）：适合 dev/staging
手动同步            ：适合 prod（点"Sync"或走 CI 触发）
```

**生产也可以自动，但前提是**：

```
① Git 有保护分支 + 必须 PR review
② 有"回滚"预案（git revert）
③ 有通知（同步了会告知）
```

### 观察与排错

```bash
# 命令行
argocd app list
argocd app get api-prod
argocd app sync api-prod
argocd app history api-prod
argocd app rollback api-prod <id>

# 看 diff
argocd app diff api-prod
```

**`argocd app diff` 是最有用的命令**：它显示"Git 期望"与"集群实际"的差异。

**常见状态**：

```
Synced     ：一致
OutOfSync  ：有差异（点 Sync）
Unknown    ：连不上集群/仓库
Degraded   ：资源不健康（Pod 没起来）
```

**"一直 Unknown"** → 检查仓库凭据与集群连通性。

### 一个端到端流水线

```
① 开发者提交代码到 app 仓库
② CI 构建镜像 → 推到 registry（tag = commit sha）
③ CI 提交到 deploy 仓库（改 image tag）
④ ArgoCD 检测到变化 → 同步到集群
⑤ 健康检查通过 → 通知
```

**每一步都有 Git 记录，任何一次部署都能追溯到 commit**。

### 检查清单

```
□ Git 是唯一事实来源
□ 镜像 tag 用不可变值（sha）
□ 镜像更新由 CI/Image Updater 自动写回
□ prod 的 targetRevision 固定（tag 或 sha）
□ Application 定义放独立仓库
□ 多环境用 Kustomize overlay
□ 密钥用 Sealed Secrets / ESO / SOPS
□ AppProject 限制源仓库与目标命名空间
□ 先 prune: false 观察再开
□ selfHeal: true（防手改）
□ 有回滚流程（git revert / app rollback）
□ 有同步通知
```
