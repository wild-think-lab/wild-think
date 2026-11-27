---
title: Argo Workflows 速查
summary: 提交/查看/重试/日志的常用命令，以及 DAG 与 artifacts 的写法要点。
group: devops
order: 1
tags: [Argo, 工作流]
---

### 提交

```bash
argo submit -n argo wf.yaml
argo submit -n argo wf.yaml --watch
argo submit -n argo wf.yaml -p cmd=extract
argo submit -n argo --from cronwf/daily-etl
```

### 查看

```bash
argo list -n argo
argo get -n argo <name>
argo get -n argo <name> -o json
argo logs -n argo <name>
argo logs -n argo <name> -c <container>
argo watch -n argo <name>
```

### 重试与停止

```bash
argo retry -n argo <name>
argo resume -n argo <name>       # 从失败节点继续
argo terminate -n argo <name>
argo stop -n argo <name>
```

**区别**：

```
retry   ：整个 workflow 重跑
resume  ：只重跑失败的节点（推荐）
```

### DAG 骨架

```yaml
spec:
  entrypoint: main
  templates:
  - name: main
    dag:
      tasks:
      - name: a
        template: step
      - name: b
        dependencies: [a]
        template: step
      - name: c
        dependencies: [a]
        template: step
      - name: d
        dependencies: [b, c]
        template: step
```

### artifacts

```yaml
      outputs:
        artifacts:
        - name: out
          path: /work/result.parquet
      arguments:
        artifacts:
        - name: out
          from: "{{tasks.a.outputs.artifacts.out}}"
```

### 参数传递

```yaml
      arguments:
        parameters:
        - name: date
          value: "{{workflow.creationTimestamp}}"
```

**常用变量**：

```
{{workflow.name}} / {{workflow.uid}}
{{inputs.parameters.x}}
{{tasks.<name>.outputs.parameters.y}}
```

### 中断与审批

```yaml
  - name: approve
    suspend: {}
```

**`argo resume`** 才继续（适合人工审批节点）。

### 定时

```yaml
kind: CronWorkflow
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 600
```

### 常见问题

| 现象 | 原因 |
| --- | --- |
| Pending 不动 | 资源不足/亲和性/镜像拉不下来 |
| artifacts 存不下 | 未配 artifactGC，或 S3 配额满 |
| 一直 Running | 缺少 activeDeadlineSeconds |
| 并发叠加 | 未设 concurrencyPolicy |
| 看不到日志 | podGC 把 Pod 删了（看归档日志） |

### 注意

```
① 每步设 resources（requests/limits）
② 每步设 activeDeadlineSeconds
③ YAML 只编排，逻辑在镜像里
④ 失败接 Alertmanager 告警
⑤ 保留策略：成功 7 天 / 失败 30 天
```
