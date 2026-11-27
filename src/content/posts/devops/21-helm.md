---
title: Helm 深入：chart 写得好不好，看这五件事
description: values 的分层、模板里的 helper、依赖与 hooks，以及五个"chart 谁都不敢改"的原因。
date: 2026-03-12
tags: [DevOps, Kubernetes, Helm]
---

### chart 的三个层次

```
① 结构：Chart.yaml / values.yaml / templates / charts
② 模板：Go template + sprig 函数 + 自定义 helper
③ 生命周期：install/upgrade/rollback + hooks
```

**"能用"是开始，"别人敢改"才是好 chart**。

### values 要分层

```yaml
# values.yaml（默认，适合本地跑）
replicaCount: 1
image:
  repository: app
  tag: latest
resources:
  requests: {cpu: 100m, memory: 128Mi}
```

```yaml
# values-prod.yaml（生产覆盖）
replicaCount: 6
image:
  tag: "1.4.2"
resources:
  requests: {cpu: "1", memory: 2Gi}
```

```bash
helm upgrade --install app ./chart -f values-prod.yaml
```

**要点**：

```
① values.yaml 里不要放"生产值"（容易误用）
② 覆盖文件按环境命名
③ tag 不要用 latest（在 values 里显式）
```

### 模板里的三个好习惯

**① 用 helper 收敛重复**

```yaml
{{- define "app.labels" -}}
app: {{ .Values.appName }}
version: {{ .Chart.AppVersion }}
{{- end -}}
```

```yaml
metadata:
  labels:
    {{- include "app.labels" . | nindent 4 }}
```

**"nindent 4"** 保证缩进正确（最常见格式问题）。

**② 必填值用 required**

```yaml
image: {{ required "image.repository is required" .Values.image.repository }}
```

**"缺了就直接失败"** 比"渲染出一个空字符串"好得多。

**③ 用 toYaml 处理 map**

```yaml
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
```

### 依赖与子 chart

```yaml
# Chart.yaml
dependencies:
- name: postgresql
  version: 13.2.0
  repository: https://charts.bitnami.com/bitnami
  condition: postgresql.enabled
```

```bash
helm dependency update ./chart
```

**`condition`** 让"依赖可开关"（本地跑不用起 PG）。

### hooks 的用法与风险

```yaml
apiVersion: v2
name: app
annotations:
  "helm.sh/hook": pre-install
```

**常见用途**：

```
① 建数据库 schema
② 预检（等待依赖就绪）
③ 迁移（升级前跑一次）
```

**风险**：

```
hook 失败 → 整个 release 失败，且可能部分执行
→ hook 里的操作必须"可重复执行且幂等"
```

### 五个"chart 谁都不敢改"的原因

**① values.yaml 巨大（500 行）**

```
没人知道哪些能改、改了会怎样
→ 只暴露"真正需要调的"，其余写死在模板里
```

**② 模板里全是 if/else**

```
嵌套 5 层的条件 → 无法调试
→ 拆成多个 chart 或用 subchart
```

**③ 没有 documentation**

```yaml
# values.yaml
# replicaCount: 副本数（不要超过 10，受 HPA 影响）
replicaCount: 3
```

**"在 values.yaml 里写注释"** 是最低成本的文档。

**④ 没有统一命名/标签**

```
有的 chart 用 appName，有的用 name
→ 组合使用时冲突
```

**⑤ 用 helm 管了"不该由 helm 管的东西"**

```
ConfigMap 里的配置频繁变 → 每次改都 upgrade
→ 配置应走配置中心/外部挂载
```

### 三个"升级出错"的常见原因

```
① values 覆盖不生效（文件顺序/未用 -f）
   helm get values app -n ns    # 看实际生效的
② 依赖没更新（Chart.lock 过期）
   helm dependency build
③ immutable 字段被改（selector/labels 变更）
   → upgrade 报 "field is immutable"，需要卸载重建
```

**"selector 不可变"** 是 deployment 的固有约束（不是 helm 的问题）。

### 检查清单

```
□ values 分层（默认 vs 各环境）
□ 必填值用 required
□ 有 helper 收敛重复
□ 模板用 nindent/toYaml
□ 依赖用 condition 可开关
□ hook 幂等且失败可恢复
□ values.yaml 有注释说明
□ 命名统一（appName 之类）
□ 复杂配置不放 ConfigMap（走外部）
□ 升级前 helm diff 看一眼
```
