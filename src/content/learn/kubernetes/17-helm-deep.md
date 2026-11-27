---
title: Helm 深度定制：从改 values 到自己写 chart
module: 进阶篇
summary: chart 结构、values 分层与环境覆盖、hooks 与依赖、模板函数与调试，五个"helm 一升就坏"的原因。
minutes: 50
---

### chart 结构

```
mychart/
├── Chart.yaml          # 名称/版本/appVersion
├── values.yaml         # 默认值
├── templates/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── _helpers.tpl    # 复用模板
│   └── NOTES.txt       # 安装后提示
└── charts/             # 子 chart（依赖）
```

```bash
helm create mychart
helm lint mychart
helm template mychart ./mychart -f values-prod.yaml | less
```

**`helm template` 不落地就能看渲染结果**——调模板必用。

### values 分层

```yaml
# values.yaml（默认，可运行）
replicaCount: 1
image: { repository: app, tag: "1.0", pullPolicy: IfNotPresent }
resources: { requests: { cpu: 100m, memory: 128Mi } }
```

```yaml
# values-prod.yaml（环境覆盖）
replicaCount: 4
image: { tag: "1.4.2" }
resources:
  requests: { cpu: "500m", memory: 512Mi }
  limits: { cpu: "2", memory: 1Gi }
```

```bash
helm upgrade --install app ./mychart -f values-prod.yaml --atomic --timeout 5m
```

**`--atomic`** 失败自动回滚；**`--timeout`** 别用默认 5 分钟等太久。

### 模板常用写法

```yaml
{{- with .Values.resources }}
resources: {{- toYaml . | nindent 10 }}
{{- end }}

labels:
  app: {{ include "mychart.name" . }}
  version: {{ .Values.image.tag | quote }}
```

```
include 比 template 好在可以管道
nindent = 换行 + 缩进（YAML 拼接必用）
```

### hooks（顺序型任务）

```yaml
metadata:
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade
    "helm.sh/hook-weight": "-5"
    "helm.sh/hook-delete-policy": before-hook-creation
```

**用途**：数据库迁移、配置校验。**注意**：hook 失败会阻塞整个安装。

### 依赖

```yaml
dependencies:
  - name: redis
    version: "19.x.x"
    repository: https://charts.example.com
    condition: redis.enabled
```

```bash
helm dependency update mychart
```

### 五个"helm 一升就坏"

**① values 缩进/类型错**

```
"1" vs 1（字符串传进副本数 → 报错）
```

**② 没设 image tag**

```
默认 latest → 升了个寂寞或拉了不兼容版本
```

**③ 资源值被环境覆盖丢失**

```
prod values 没写 resources → 回落到默认，OOM
```

**④ hook 卡住**

```
Job 一直不结束 → upgrade 挂起
```

**⑤ 用了 `helm upgrade --force`**

```
强制重建 → 滚动发布变全量重启
```

### 调试三板斧

```bash
helm template app ./mychart -f values-prod.yaml   # 渲染
helm get manifest app                             # 当前集群里的
helm get values app                               # 实际生效值
helm history app                                  # 版本历史
helm rollback app 3                               # 回滚到版本 3
```

### 检查清单

```
□ chart 有 lint 检查
□ values 分环境（base + prod）
□ 副本/资源有明确覆盖
□ 镜像 tag 必填（禁 latest）
□ 关键模板有 include 复用
□ hook 有 weight 与删除策略
□ 升级用 --atomic + 合理 timeout
□ 有 helm history/rollback 习惯
□ 有 Chart 版本号管理
□ CI 里先 template 再 apply
```
