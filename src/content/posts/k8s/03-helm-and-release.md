---
title: 用 Helm 管发布：从手写 YAML 到可回滚的版本
description: Helm 解决什么问题、chart 的最小结构、values 分环境覆盖、release 回滚与 CI 里的用法。
date: 2026-11-27
tags: [Kubernetes, Helm, CI/CD, 发布]
---

### 手写 YAML 的三个痛点

1. 多环境要复制三份（dev/staging/prod），改一处忘两处。
2. 升级镜像版本要 `sed` 改文件，容易漏。
3. 回滚只能靠记住上一个 `image: tag`。

Helm 的本质是**模板 + 参数 + 版本记录**，正好对上这三条。

### 最小 chart 结构

```
web-chart/
├── Chart.yaml
├── values.yaml
└── templates/
    ├── deployment.yaml
    ├── service.yaml
    └── ingress.yaml
```

`Chart.yaml`：

```yaml
apiVersion: v2
name: web-chart
version: 0.1.0        # chart 版本，改动必须升
appVersion: "1.0.0"   # 应用版本，仅作标注
```

`values.yaml`：

```yaml
image:
  repository: registry.example.com/web
  tag: "1.0.0"
replicaCount: 2
resources:
  requests: { cpu: 100m, memory: 128Mi }
  limits:   { cpu: 500m, memory: 512Mi }
ingress:
  enabled: true
  host: app.example.com
```

`templates/deployment.yaml`：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-web
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels: { app: {{ .Release.Name }}-web }
  template:
    metadata:
      labels: { app: {{ .Release.Name }}-web }
    spec:
      containers:
        - name: web
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          resources: {{- toYaml .Values.resources | nindent 12 }}
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
```

### 分环境覆盖

```bash
helm upgrade --install web ./web-chart \
  -f values.yaml -f values-prod.yaml \
  --set image.tag=1.0.3 \
  --namespace prod --create-namespace
```

`--set` 优先级最高，适合 CI 传版本号；`-f` 用来覆盖环境差异（副本数、资源、域名）。

### release 与回滚

```bash
helm list -n prod
helm history web -n prod
helm rollback web 3 -n prod      # 回到 revision 3
```

**这是 Helm 最大的价值**：每次 `upgrade` 都是一条版本记录，回滚不需要重新构建。

配合 `--atomic`：升级失败自动回滚。

```bash
helm upgrade --install web ./web-chart --atomic --timeout 120s -n prod
```

### 在 CI 里怎么用

```yaml
- name: Render & lint
  run: |
    helm lint ./web-chart
    helm template web ./web-chart -f values.yaml -f values-prod.yaml > /tmp/rendered.yaml
    grep -q "image: registry.example.com/web:${GITHUB_SHA:0:7}" /tmp/rendered.yaml

- name: Deploy
  run: |
    helm upgrade --install web ./web-chart \
      --set image.tag=${GITHUB_SHA:0:7} \
      --atomic --timeout 180s \
      -n prod
```

`helm template` 先渲染出来检查，能在部署前抓住模板语法错误。

### 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `values` 改了没生效 | 用了 `--reuse-values` 且旧值优先 | 显式 `-f` 或 `--reset-values` |
| 回滚后配置仍是新的 | ConfigMap 未随 release 更新 | 把配置也放进 chart，别手工 apply |
| `helm upgrade` 卡住 | 上一个 release 处于 pending | `helm list --pending`，必要时 `--force` |
| Secret 进了 Git | 把密码写进 values.yaml | 用 External Secrets / SealedSecrets |

### 什么时候不需要 Helm

- 只有一套 YAML、一个环境、一个人维护 → 直接 `kubectl apply` 更简单。
- 团队已用 Kustomize → 不必强行换，Kustomize 的 overlay 也能覆盖多环境。

工具的价值是**减少重复劳动**，不是增加流程。判断标准很简单：你每周改几次镜像版本？改 3 次以上，Helm 就值得。
