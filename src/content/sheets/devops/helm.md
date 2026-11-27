---
title: Helm 速查
summary: chart 结构、install/upgrade/rollback、values 覆盖与调试，以及"渲染结果不对"的排查方式。
group: devops
order: 2
tags: [Helm, Kubernetes]
---

### 常用命令

```bash
helm create mychart
helm lint ./mychart
helm template ./mychart -f values-prod.yaml    # 只看渲染结果（不装）
helm install app ./mychart -n app --create-namespace
helm install app ./mychart -f values-prod.yaml -n app
helm upgrade app ./mychart -f values-prod.yaml -n app
helm upgrade --install app ./mychart -n app     # 幂等安装
helm list -n app
helm status app -n app
helm history app -n app
helm rollback app 3 -n app
helm uninstall app -n app --keep-history
```

### values 与调试

```bash
helm show values ./mychart
helm get values app -n app          # 实际生效的值
helm get manifest app -n app        # 渲染后的清单
helm get all app -n app
helm diff upgrade app ./mychart -n app   # 需要 diff 插件
```

### 依赖

```bash
helm dependency update ./mychart    # 拉依赖 + 生成 lock
helm dependency build ./mychart
```

```yaml
# Chart.yaml
dependencies:
- name: redis
  version: 20.x.x
  repository: https://charts.bitnami.com/bitnami
  condition: redis.enabled
```

### 模板常用

```yaml
{{ .Values.image.tag | default "1.0.0" }}
{{ required "image.repository required" .Values.image.repository }}
{{ include "app.labels" . | nindent 4 }}
{{ toYaml .Values.resources | nindent 6 }}
{{ if .Values.ingress.enabled }}...{{ end }}
{{ range .Values.hosts }}...{{ end }}
```

### 常用函数

```
default / required / quote / upper / lower
nindent / indent / trim
toYaml / fromYaml
b64enc
sha256sum        # 用于 checksum annotation
```

### 五个常见问题

| 现象 | 原因 |
| --- | --- |
| values 覆盖不生效 | `-f` 顺序/未用对文件 |
| 渲染失败 | 模板缩进/undefined |
| upgrade 报 immutable | selector/labels 变了 |
| 依赖缺失 | 未 `dependency build` |
| 见不到实际值 | 用 `helm get values` 确认 |

### 检查清单

```
□ lint + template 先看渲染结果
□ values 分层（默认 vs 环境）
□ 必填值用 required
□ 有 diff 插件（升级前比对）
□ 依赖有 lock
□ release 有 history（可回滚）
□ 不直接改 /lib 下的 unit（同理：改 chart 走版本）
```
