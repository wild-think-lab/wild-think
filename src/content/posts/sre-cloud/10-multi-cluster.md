---
title: 多集群管理：从"三个集群三套密码"到统一视图
description: 多集群为什么会出现、四种管理模式的取舍、kubectl 上下文与命名规范、以及"配置漂移"的治理。
date: 2026-11-27
tags: [Kubernetes, 多集群, 运维, GitOps]
---

### 为什么会有多集群

```
① 环境隔离（开发/测试/预发/生产）
② 地域分离（华北/华南，甚至国内外）
③ 业务隔离（不同事业部、不同客户）
④ 合规要求（数据不出境、等保分区）
⑤ 容量上限（单集群规模有瓶颈）
```

**多集群是成本**：每多一个集群，就多一套升级、监控、证书、备份流程。

### 四种管理模式

| 模式 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 独立管理 | 每个集群一套 kubectl/CI | 简单 | 重复劳动，易漂移 |
| 配置即代码 | 同一仓库，按目录区分集群 | 可审计、可回滚 | 需要 CI 支持 |
| 中心化平台 | Rancher / KubeSphere | 统一视图 | 引入新组件 |
| 集群联邦 | Karmada / Cluster API | 跨集群调度 | 复杂，运维门槛高 |

**推荐路径**：先"配置即代码"（性价比最高），集群数量 > 5 再考虑中心化平台。

### 配置即代码的目录结构

```
deploy/
├── base/                      # 所有集群共用
│   ├── api/
│   │   ├── deployment.yaml
│   │   └── kustomization.yaml
│   └── db/
├── overlays/
│   ├── dev/
│   │   ├── kustomization.yaml
│   │   └── patch-replicas.yaml
│   ├── staging/
│   └── prod/
│       ├── kustomization.yaml
│       └── patch-resources.yaml
└── clusters.yaml              # 集群清单
```

`overlays/prod/kustomization.yaml`：

```yaml
resources:
- ../../base/api
patches:
- path: patch-resources.yaml
images:
- name: registry/api
  newTag: v1.8.2
```

**同一条命令部署不同环境**：

```bash
kubectl apply -k deploy/overlays/prod --context prod-cn
```

### kubectl 上下文管理

```bash
# 命名规范：<环境>-<地域>
kubectl config get-contexts
kubectl config rename-context old-name prod-cn
kubectl config use-context staging-cn
```

**上下文命名一定要带环境前缀**，否则 `kubectl delete` 打错集群是常见事故。

**防误操作**：

```bash
# 在 .bashrc 里显示当前上下文
PS1='[\u@\h \W]$(kubectl config current-context 2>/dev/null | sed "s/^/ (/" | sed "s/$/)/") \$ '

# 或用 kubectx/kubens
kubectx prod-cn
kubens api
```

**危险操作前先确认**：

```bash
kubectl config current-context
kubectl get ns | head
```

### 配置漂移：多集群最大的问题

**漂移**：手动改过某个集群，与 Git 里的配置不一致。

发现漂移：

```bash
# 用 diff 比较"Git 里的"与"集群里的"
kubectl diff -k deploy/overlays/prod --context prod-cn
```

治理：

```
① 禁止直接 kubectl apply（CI 是唯一入口）
② 定期跑 kubectl diff，有差异就告警
③ 用 ArgoCD/Flux 强制同步（drift 会被自动纠正）
```

ArgoCD 的 drift 检测：

```yaml
syncPolicy:
  automated:
    prune: true
    selfHeal: true        # 有人手改了会被改回来
```

### 统一视图：你需要看到什么

| 视图 | 工具 |
| --- | --- |
| 集群健康（节点、版本） | Rancher / 自建 dashboard |
| 应用状态（副本、重启） | 各集群 Prometheus + 统一 Grafana |
| 资源使用趋势 | 同上 |
| 证书到期 | 统一扫描（cert-manager + 告警） |
| 版本一致性 | 定期采集 kubelet 版本 |

**Grafana 的"集群变量"**：

```
每个集群部署 Prometheus，指标打上 cluster="prod-cn" 标签
→ 一个 Grafana 面板，用 $cluster 变量切换
```

### 升级节奏

多集群升级最怕"一次全升"。

```
① 先升 dev（验证流程）
② 再升 staging（验证业务）
③ 生产按"一个集群一个集群"升，每次间隔观察 1–2 天
④ 保持 N-1：允许有一个小版本差异
```

版本一致性矩阵（示例）：

| 集群 | 版本 | 状态 |
| --- | --- | --- |
| dev-cn | 1.31 | 最新 |
| staging-cn | 1.30 | N-1 |
| prod-cn | 1.30 | N-1 |
| prod-hk | 1.29 | 待升 |

### 一个真实的收敛过程

改造前：

- 4 个集群，每个集群有人手工 `kubectl apply`。
- 同一个服务在 4 个集群的镜像 tag 各不相同（有的还是 v1.5）。
- 出问题时要挨个登录检查。

改造：

```
① 所有 manifest 进 Git，kustomize 分环境
② CI 统一 apply（人工审批生产）
③ ArgoCD 托管 4 个集群，selfHeal 打开
④ 统一 Prometheus 打 cluster 标签，一个面板看全部
```

收益：

- 版本一致性从"靠人记"变成"看 Git"。
- 事故定位时间从 30 分钟降到 5 分钟。

### 检查清单

```
□ 上下文命名带环境前缀
□ 有"当前上下文"提示（PS1 或 kubectx）
□ manifest 全部在 Git，kustomize/helm 分环境
□ CI 是唯一部署入口
□ kubectl diff 定期跑，或 ArgoCD selfHeal
□ 统一监控带 cluster 标签
□ 升级按 dev → staging → prod 逐个来
```
