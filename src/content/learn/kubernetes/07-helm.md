---
title: 第 7 章 · Helm：把一堆 YAML 变成可发布的产品
module: 进阶篇
summary: Chart 的目录结构、values 分层、模板语法与常用函数、依赖管理、release 的升级与回滚，以及"helm 装的和平常用的不一样"的原因。
minutes: 20
---

### 为什么需要 Helm

一个中等应用要 8–12 个 YAML：Deployment、Service、Ingress、ConfigMap、Secret、HPA、PDB、ServiceAccount…。多环境 × 多实例，就是几十份几乎一样只差几个值的文件。

Helm 解决：**把 YAML 模板化 + 把差异抽成 values + 把一次安装记成一个 release**。

### Chart 目录结构

```
mychart/
├── Chart.yaml           # 名称、版本、依赖
├── values.yaml          # 默认值
├── templates/
│   ├── _helpers.tpl     # 公共模板片段（命名约定 _ 开头不会被渲染成文件）
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   └── NOTES.txt        # 安装后提示信息
├── charts/              # 子 chart（依赖）
└── .helmignore
```

```yaml
# Chart.yaml
apiVersion: v2
name: order-api
version: 0.1.0
appVersion: "1.4.2"
dependencies:
- name: redis
  version: 20.x.x
  repository: https://charts.bitnami.com/bitnami
  condition: redis.enabled
```

### values 分层

```yaml
# values.yaml（默认，开发环境友好）
replicaCount: 1
image:
  repository: registry.example.com/order-api
  tag: latest
resources:
  requests: { cpu: 100m, memory: 128Mi }
  limits:   { cpu: 500m, memory: 512Mi }
ingress:
  enabled: false
redis:
  enabled: false
```

```yaml
# values-prod.yaml（覆盖）
replicaCount: 3
image:
  tag: "1.4.2"
ingress:
  enabled: true
  hosts: [{ host: app.example.com, paths: ["/"] }]
redis:
  enabled: true
```

```bash
helm upgrade --install order-api ./mychart \
  -f values-prod.yaml \
  --namespace prod --create-namespace
```

优先级：`values.yaml` < `-f` 文件（后面的覆盖前面的）< `--set`。

### 模板语法与常用函数

```yaml
metadata:
  name: {{ include "mychart.fullname" . }}
  labels:
    {{- include "mychart.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
      - name: {{ .Chart.Name }}
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
        resources:
          {{- toYaml .Values.resources | nindent 10 }}
        env:
        - name: LOG_LEVEL
          value: {{ .Values.logLevel | default "info" | quote }}
```

四个高频函数：

| 函数 | 用途 |
| --- | --- |
| `include` / `template` | 引入 `_helpers.tpl` 里的片段 |
| `toYaml` | 把 map/struct 转成 YAML（配 `nindent`） |
| `nindent N` | 换行 + 缩进 N 个空格（缩进错乱全靠它） |
| `quote` | 加引号，避免 `yes/no` 被当成布尔 |

`{{-` 的短横线是**去掉前面空白**，用来控制渲染后不出现多余空行。

### 调试模板

```bash
helm template order-api ./mychart -f values-prod.yaml | less
helm lint ./mychart
helm install --dry-run --debug order-api ./mychart
```

**改 chart 一定要先 `template` 看一眼渲染结果**。缩进错一位，渲染出的 YAML 就是坏的，但 `helm lint` 未必能发现。

### release 的升级与回滚

```bash
helm list -A
helm history order-api -n prod
helm upgrade order-api ./mychart -f values-prod.yaml -n prod
helm rollback order-api 3 -n prod
helm get values order-api -n prod      # 当前生效的值
helm get manifest order-api -n prod    # 当前实际部署的 YAML
```

`helm rollback` 是把**整份 release 的 manifest** 退回去，包括 ConfigMap。这是它比"只回滚镜像"更彻底的地方。

### "helm 装的和平常用的不一样"

三种常见原因：

1. **`kubectl edit` 改过，然后 `helm upgrade` 覆盖了**。Helm 只认自己渲染出的 manifest，手工改的会被拉平。
2. **模板里有 `randAlphaNum`、`now`**，每次渲染都变，导致每次 upgrade 都是"全量更新"。
3. **子 chart 的 values 没覆盖到**。子 chart 的值要用 `redis.auth.password` 这样的嵌套路径。

判断是否被"覆盖"：

```bash
helm get manifest order-api -n prod | diff - <(kubectl -n prod get deploy order-api -o yaml)
```

### Helm 与 GitOps 的关系

ArgoCD 支持 Helm：它自己渲染，不用 `helm install`。这时 **release 记录在 ArgoCD 里，不在 Helm 的 secret 里**，所以 `helm list` 看不到——这不代表没部署。

两种模式的取舍：

- `helm install` + CI：传统，靠 Helm 管 release 历史。
- ArgoCD + Helm：GitOps，靠 Git 管历史，`helm list` 为空是正常的。

别混用同一个 chart 的两种部署方式，会出现"两份 release 抢同一批资源"。

### 平台化建议

内部平台常用"三层"：

```
基础 chart（团队维护，稳定）
  ↑
业务 chart（各团队基于基础 chart 派生）
  ↑
values 仓库（每个环境一份，走 GitOps）
```

这样平台改基础能力，业务只改 values，不用碰模板。
