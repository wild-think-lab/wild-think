---
title: 多集群管理：切换、GitOps 与灾备
module: 进阶篇
summary: kubeconfig 上下文管理、多集群 GitOps 分发、跨集群灾备与容量，五个"集群多了就失控"的原因。
minutes: 45
---

### 先管好 kubeconfig

```bash
kubectl config get-contexts
kubectl config use-context prod-cn
kubectl config rename-context old-name prod-cn
```

```bash
# 用别名防误操作（强烈建议）
alias kp='kubectl --context prod-cn'
alias ks='kubectl --context staging'
```

**"生产/测试一串命令敲错"** → 用别名或 `kubectx`，并在提示符显示当前上下文。

```bash
# 提示符里显示上下文（bash 示例）
export PS1='[\u@\h $(kubectl config current-context 2>/dev/null)] \$ '
```

### 多集群的三种形态

```
① 环境隔离（dev/staging/prod）
② 区域隔离（cn/eu/us，贴近用户）
③ 租户隔离（每客户一集群）
```

**判据**：不要为了"省资源"把生产与测试塞一个集群。

### GitOps 多集群分发

```yaml
# ArgoCD ApplicationSet：一套配置发多个集群
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
spec:
  generators:
    - list:
        elements:
          - cluster: cn
            server: https://10.0.1.10:6443
          - cluster: eu
            server: https://10.0.2.10:6443
  template:
    metadata: { name: 'app-{{cluster}}' }
    spec:
      project: default
      destination: { server: '{{server}}', namespace: app }
      source:
        repoURL: https://git.example.com/platform.git
        path: apps/order
        targetRevision: main
```

**收益**：一次提交，多集群同步；漂移可检测。

### 灾备（跨集群）

```
① 数据：DB 跨区域复制 + 对象存储 mirror
② 配置：GitOps 仓库即真相（集群可重建）
③ 镜像：registry 复制到备区
④ DNS：切换入口（低 TTL）
⑤ 演练：每季度切一次
```

**判据**：RTO 由"能否重建集群"决定，RPO 由数据复制方式决定。

### 五个"集群多了就失控"

**① 配置漂移**

```
手工改过的东西 Git 里没有 → 重建即丢
```

**② 版本不一致**

```
cn 是 1.30，eu 是 1.28 → 同一 chart 行为不同
```

**③ 凭据散落**

```
每个集群一套 kubeconfig，谁有哪套不清楚
```

**④ 无统一观测**

```
出问题要登 5 个集群看 5 个面板
```

**⑤ 备份只在主区**

```
主区整体故障 → 备区没数据
```

### 统一观测与成本

```
① 指标集中（每集群 remote_write 到一个 Prometheus）
② 日志集中（Loki/ES 汇聚）
③ 成本按集群/命名空间分摊
```

```yaml
# Prometheus remote_write
remote_write:
  - url: https://metrics.example.com/api/v1/write
```

### 检查清单

```
□ 上下文命名清晰 + 别名/提示符
□ 生产与测试物理或逻辑隔离
□ GitOps 多集群分发（ApplicationSet）
□ 集群版本统一（升级计划）
□ 有配置漂移检测
□ 凭据集中管理（谁有哪套）
□ 指标/日志集中
□ 数据跨区域复制
□ 镜像已复制到备区
□ 有切换演练记录
```
