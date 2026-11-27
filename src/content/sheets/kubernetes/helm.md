---
title: Helm 常用命令速查
summary: 装、升、滚、查、删五件事，加上 values 覆盖顺序、仓库管理与排错时最常看的三条。
group: Kubernetes
order: 6
tags: [helm, k8s, 发布]
---

### 装与升

```bash
# 安装（首次）
helm install myapp ./chart -n prod -f values-prod.yaml

# 升级（常规发布）
helm upgrade myapp ./chart -n prod -f values-prod.yaml

# 升级或安装（CI 里最常用，幂等）
helm upgrade --install myapp ./chart -n prod -f values-prod.yaml --atomic --timeout 5m

# 带镜像版本覆盖
helm upgrade --install myapp ./chart -n prod \
  --set image.tag=1.2.3 --set replicaCount=4
```

`--atomic`：失败自动回滚到上一版本。生产发布建议默认加。

### 查

```bash
helm list -n prod -a              # 所有 release（含失败）
helm status myapp -n prod         # 状态与 NOTES
helm history myapp -n prod        # 版本历史（可回滚）
helm get values myapp -n prod     # 当前生效的 values
helm get manifest myapp -n prod   # 渲染出的最终 YAML
helm get all myapp -n prod        # 全部
```

`helm get manifest` 是排障神器：能看到最终提交给 K8s 的完整清单，避免"以为改了但没生效"。

### 滚

```bash
helm rollback myapp 3 -n prod              # 回滚到版本 3
helm rollback myapp 0 -n prod --wait       # 回滚到上一版并等待就绪
```

### 删

```bash
helm uninstall myapp -n prod
helm uninstall myapp -n prod --keep-history   # 保留历史记录
```

### 模板调试（改 chart 时用）

```bash
# 只渲染不安装，看输出
helm template myapp ./chart -f values-prod.yaml -n prod

# 渲染并 lint
helm lint ./chart -f values-prod.yaml

# 对比升级会改什么（需要插件）
helm diff upgrade myapp ./chart -n prod -f values-prod.yaml
```

`helm template` + `--debug` 能看到渲染细节与失败原因。

### values 覆盖顺序

```
默认 values.yaml
  → 父 chart 的 values（依赖场景）
  → -f values-a.yaml -f values-b.yaml（后者覆盖前者）
  → --set / --set-string（最优先）
```

`--set-string` 与 `--set` 的区别：前者强制当字符串（避免 `1.2` 被解析成数字）。

### 仓库

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm search repo nginx
helm search hub nginx           # 搜 Artifact Hub

# OCI 仓库（新版）
helm push ./chart-1.0.0.tgz oci://registry.example.com/charts
helm install myapp oci://registry.example.com/charts/myapp --version 1.0.0
```

### 依赖

```bash
helm dependency update ./chart     # 更新 Chart.lock 与 charts/
helm dependency list ./chart
```

### 三个高频报错

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `another operation in progress` | 上一次操作未完成，留下锁 | `helm history` 后决定 rollback 或等超时 |
| `rendered manifest is invalid` | 模板语法错 | `helm template --debug` 看具体行 |
| `UPGRADE FAILED: cannot patch` | 字段不可变（如 selector） | 删了重装，或改 chart 用不可变字段 |
