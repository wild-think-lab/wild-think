---
title: 交付：从 CI 到 GitOps，以及渐进式发布
module: 进阶篇
summary: 流水线三段（构建/验证/交付）、镜像写回的两种方式、金丝雀与功能开关，以及"发布失败怎么退"。
minutes: 22
---

### 一条完整的交付链

```
① 构建：代码 → 镜像（tag = commit sha）
② 验证：测试、扫描、签名
③ 交付：修改部署仓库 → 集群同步
```

**"交付"不是"部署"，交付是"让变更可被安全地应用"**。

### 三段各自的"必须项"

**① 构建段**

```
依赖锁定（lock 文件）
多阶段构建（小镜像）
tag 用 sha（不用 latest）
```

**② 验证段**

```
单元测试 + 静态检查（快，每个 PR 都跑）
镜像扫描（trivy）
集成测试（慢，合并前跑）
```

**③ 交付段**

```
改的是"部署仓库"（不是应用仓库）
变更走 PR + review
应用用 GitOps（ArgoCD/Flux）
```

**"CI 直接 kubectl apply"的问题**：

```
CI 有集群写权限（凭据泄露风险高）
变更没有 review（CI 里改了啥看不清）
回滚要重新跑流水线（慢）
```

### 镜像写回的两种方式

**方式一：CI 提交到部署仓库**

```yaml
# .github/workflows/deploy.yml 片段
- name: Bump image tag
  run: |
    cd deploy-repo
    yq -i ".images.api = \"${{ github.sha }}\"" envs/prod/api/values.yaml
    git commit -am "bump api to ${{ github.sha }}"
    git push
```

**优点**：

```
可审计（每次变更都是一个 commit）
可回滚（git revert）
```

**方式二：Image Updater 自动改**

```
ArgoCD Image Updater 监听镜像仓库
→ 发现新 tag 自动改 Application
```

**优点**：省掉 CI 的写权限。
**缺点**：变更来源不在你的 CI 里（审计链稍弱）。

**推荐方式一**（审计清晰），方式二作为补充。

### 渐进式发布的三种手段

**① 副本比例（金丝雀 Deployment）**

```
主 Deployment：3 副本
金丝雀 Deployment：1 副本 + 不同 label
Ingress 按 header/权重分流
```

**② 功能开关（Feature Flag）**

```javascript
if (flags.isEnabled('new-checkout', user.id)) {
  return newCheckout();
}
return oldCheckout();
```

**优点**：

```
出问题秒级关闭（不用回滚镜像）
可按用户/租户灰度
```

**代价**：代码里长期维护两套逻辑（要定期清理）。

**③ 流量比例（Ingress 权重）**

```yaml
annotations:
  nginx.ingress.kubernetes.io/canary: "true"
  nginx.ingress.kubernetes.io/canary-weight: "10"
```

**"10% → 观察 → 50% → 100%"** 是最常见路径。

### 发布失败怎么退

```
① 应用层：回滚镜像（kubectl set image 到旧 tag）
② 配置层：回滚 ConfigMap/部署仓库（git revert）
③ 数据层：迁移脚本必须有"可回滚"设计（最难）
④ 功能层：关开关（最快）
```

**"数据库迁移"是最难回滚的一环**：

```
建议：
① 迁移脚本"向前兼容"（新代码能读旧结构）
② 分批迁移（先加列、后写、再用、最后删旧列）
③ 不在同一次发布里做"结构变更 + 代码切流"
```

**"一次发布同时改表结构和代码"是事故高发区**。

### 一条"标准"流水线

```yaml
steps:
- checkout
- setup（语言环境）
- lint + unit test          # 3–5 分钟
- build image               # tag = sha
- trivy scan                # 高危则失败
- push image
- bump deploy repo         # 只有 main 分支做
- wait for rollout         # 可选：等 ArgoCD 同步
```

**总时长目标**：**PR 阶段 < 8 分钟**（超过就没人愿意等）。

### 五个让交付"越做越慢"的原因

```
① PR 阶段跑了集成测试（每次 20 分钟）
   → 集成测试放合并前，PR 只跑单测 + lint
② 每次重建依赖（没缓存）
③ 串行执行（lint/test/build 本可并行）
④ 镜像太大（拉取就花几分钟）
⑤ 环境只有一套（所有人都排队等测试环境）
```

**"PR 慢"会直接导致"合并批量变大"，进而提高发布风险**。

### 环境怎么分

```
dev：每次合并自动部署（快速反馈）
staging：发布前手动/自动部署（接近生产）
prod：走审批 + 灰度
```

**"staging 与 prod 配置不一致"会让 staging 失去意义**：

```
用同一份 Kustomize base + 少量 overlay 差异
```

### 检查清单

```
□ 三段职责清晰（构建/验证/交付）
□ 依赖锁定 + tag 用 sha
□ 有镜像扫描
□ 部署仓库与代码仓库分开
□ 变更走 PR + review
□ GitOps 同步（ArgoCD/Flux）
▸ 有金丝雀或功能开关
□ 回滚路径明确（镜像/配置/数据/开关）
□ 数据库迁移向前兼容 + 分批
□ PR 阶段 < 8 分钟
□ dev/staging/prod 配置同源（Kustomize overlay）
```
