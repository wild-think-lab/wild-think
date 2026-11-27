---
title: Argo Workflows：把"一堆脚本"变成可重跑的流水线
description: DAG 与步骤式两种模板、artifacts 传递、与 CI 的分工，以及五个把工作流用成"定时脚本"的误区。
date: 2026-11-27
tags: [Kubernetes, 工作流, Argo]
---

### 与 CI 的分工

```
CI（GitHub Actions/GitLab CI）：代码提交触发，构建与测试
Argo Workflows              ：数据处理/批任务/复杂 DAG（在 K8s 里跑）
```

**"每天凌晨跑 20 个有依赖的批任务"** 是它的主战场（不是替代 CI）。

### 两种模板风格

**① steps（顺序 + 可并行）**

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: etl-
spec:
  entrypoint: main
  templates:
  - name: main
    steps:
    - - name: extract
        template: run
        arguments:
          parameters: [{name: cmd, value: "python extract.py"}]
    - - name: transform
        template: run
        arguments:
          parameters: [{name: cmd, value: "python transform.py"}]
    - - name: load
        template: run
        arguments:
          parameters: [{name: cmd, value: "python load.py"}]
  - name: run
    inputs:
      parameters:
      - name: cmd
    container:
      image: registry.example.com/etl:1.0
      command: [sh, -c]
      args: ["{{inputs.parameters.cmd}}"]
```

**② dag（显式依赖）**

```yaml
  - name: main
    dag:
      tasks:
      - name: a
        template: run
      - name: b
        dependencies: [a]
        template: run
      - name: c
        dependencies: [a]
        template: run
      - name: d
        dependencies: [b, c]
        template: run
```

**"b 与 c 并行，d 等两者都完成"** —— DAG 的价值。

### artifacts（步骤间传数据）

```yaml
    - name: extract
      template: run
      outputs:
        artifacts:
        - name: data
          path: /work/data.parquet
    - name: transform
      template: run
      arguments:
        artifacts:
        - name: data
          from: "{{tasks.extract.outputs.artifacts.data}}"
```

**要点**：

```
① artifacts 默认存在 artifactRepository（S3/MinIO）
② 大文件要配 artifactGC（否则存储爆炸）
③ 优先"传路径 + 共享 PVC"，大文件别走 artifacts
```

### 重试与超时

```yaml
      retryStrategy:
        limit: 3
        retryPolicy: OnFailure
        backoff:
          duration: "1m"
          factor: 2
          maxDuration: "10m"
      activeDeadlineSeconds: 3600
```

**"没有 activeDeadlineSeconds 的任务可能永远卡着"**。

### 五个把工作流用成"定时脚本"的误区

**① 只当 cron 用**

```
用 CronWorkflow 跑"单脚本" → 其实 systemd timer 更轻
工作流的价值在"DAG + 重试 + 可视化 + 产物追踪"
```

**② 不设资源限制**

```
容器不设 limits → 一个任务打爆节点
```

```yaml
      resources:
        requests: {cpu: 500m, memory: 512Mi}
        limits: {cpu: "2", memory: 2Gi}
```

**③ artifacts 不清理**

```
每天 10GB artifacts，一年 = 3.6TB
→ 必须配 artifactGCStrategy
```

**④ 把业务逻辑塞进 YAML**

```
几百行 if/else 写在 workflow 里 → 无法测试
→ YAML 只做"编排"，逻辑放镜像里
```

**⑤ 没有"幂等"设计**

```
任务失败重试 → 重复写入数据
→ 每个步骤要能"重跑安全"（幂等）
```

### 与 CronJob 的选择

| 需求 | 选择 |
| --- | --- |
| 单脚本定时 | CronJob / systemd timer |
| 多步骤有依赖 | Argo Workflows |
| 需要产物与可视化 | Argo Workflows |
| 需要人工审批节点 | Argo Workflows（suspend） |
| 数据管道（长任务） | Argo Workflows |

### 可观测与治理

```
① 每个 workflow 有 owner 标签（谁维护）
② 失败告警（推荐接 Alertmanager）
③ 保留历史（成功的留 7 天，失败的留 30 天）
④ 限制并发（防止同时跑 100 个）
```

**"并发限制"很关键**：

```
每天触发的 workflow 如果上次没跑完 → 叠加成风暴
→ 用 concurrencyPolicy: Replace/Forbid
```

### 一个"实用"的模板骨架

```yaml
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: daily-etl
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 600
  workflowSpec:
    entrypoint: main
    podGC: {strategy: OnWorkflowCompletion}
    ttlStrategy: {secondsAfterCompletion: 604800}
    templates:
    - name: main
      dag:
        tasks:
        - name: extract
          template: step
          arguments: {parameters: [{name: c, value: extract}]}
        - name: transform
          dependencies: [extract]
          template: step
          arguments: {parameters: [{name: c, value: transform}]}
    - name: step
      inputs: {parameters: [{name: c}]}
      retryStrategy: {limit: 2}
      activeDeadlineSeconds: 1800
      container:
        image: registry.example.com/etl:1.0
        command: [sh, -c]
        args: ["python {{inputs.parameters.c}}.py"]
        resources:
          requests: {cpu: 500m, memory: 512Mi}
          limits: {cpu: "2", memory: 2Gi}
```

### 检查清单

```
□ 明确与 CI 的分工（不混用）
□ 多步骤用 DAG（显式依赖）
□ 每步设 activeDeadlineSeconds
□ 有 retryStrategy（幂等前提下）
□ artifacts 有 GC 策略
□ 大文件走 PVC 而非 artifacts
□ 容器设 requests/limits
□ 逻辑在镜像里，YAML 只编排
□ 有并发策略（Forbid/Replace）
□ 失败告警接入
□ 有 owner 标签与保留策略
```
