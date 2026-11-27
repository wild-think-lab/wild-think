---
title: Job 与 CronJob：批处理任务在 K8s 上的正确写法
description: Job 的四种完成语义、并行度与索引、失败重试与 backoff、CronJob 的时区与并发策略、以及"任务跑了两次"的常见原因。
date: 2026-11-27
tags: [Kubernetes, Job, CronJob, 批处理]
---

### 为什么不能"用 Deployment 跑一次性任务"

Deployment 的语义是"保持 N 个副本一直活着"。一次性任务跑完就退出，Deployment 会不断重启它。

Job 的语义是"成功完成一次（或 N 次）"，`completions` 达标就停止。

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: report-gen }
spec:
  completions: 1
  parallelism: 1
  backoffLimit: 3
  activeDeadlineSeconds: 3600
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: gen
        image: registry/report:1.2
        args: ["--date", "2026-11-27"]
```

四个字段的含义：

| 字段 | 作用 |
| --- | --- |
| `completions` | 需要成功完成几次 |
| `parallelism` | 同时跑几个 Pod |
| `backoffLimit` | 失败重试次数（指数退避） |
| `activeDeadlineSeconds` | 总超时，超过就判定失败 |

### 四种完成语义

```
completions=1, parallelism=1   单次任务（最常见）
completions=1, parallelism=N   并行处理一个大任务（N 个 Pod 分片）
completions=N, parallelism=M   N 次独立任务，最多 M 个并发（队列消费）
completions=N, parallelism=N   N 个分片同时跑
```

**分片任务的正确写法**：用 `JOB_COMPLETION_INDEX` 环境变量（K8s 1.28+ 自动注入）或自己传参：

```yaml
env:
- name: SHARD
  valueFrom:
    fieldRef:
      fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
```

每个 Pod 处理自己那一份数据，避免重复。

### 失败重试与"跑了两次"

`restartPolicy` 有两个值：

- `Never`：Pod 失败不重启，整次任务算失败（计一次 backoff）。
- `OnFailure`：Pod 内重启容器（同一 Pod 内重试）。

**"任务跑了两次"的三个原因**：

1. `backoffLimit` 触发重试，但任务本身**不幂等**（第一次其实成功了，只是退出码非 0）。
2. `restartPolicy: OnFailure` + 应用自己也有重试逻辑，叠成双倍。
3. 任务中途节点故障，Job 控制器判定失败并在别的节点重跑。

修法：

- **任务必须幂等**（按 `date + shard` 覆盖写，而不是 append）。
- 用 `activeDeadlineSeconds` 兜住"卡死"的情况。
- 关键任务用唯一锁（Redis/DB）防止并发重复执行。

### 观察与清理

```bash
kubectl get job report-gen
# NAME  COMPLETIONS  DURATION  AGE
# report-gen  1/1      42s      3m

kubectl get pod -l job-name=report-gen
kubectl logs job/report-gen
```

Job 完成后 Pod 不会自动删除（保留日志便于排查）。要自动清理：

```yaml
spec:
  ttlSecondsAfterFinished: 3600   # 1 小时后删除
```

没有这个字段，集群里会积累大量 Completed Pod。

### CronJob：五个易错点

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly-report }
spec:
  schedule: "0 2 * * *"
  timeZone: "Asia/Shanghai"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 600
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  suspend: false
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: Never
          containers:
          - name: r
            image: registry/report:1.2
```

**① 时区**

默认是 **kube-controller-manager 所在节点的时区**（通常是 UTC）。不设 `timeZone` 就会"每天凌晨 2 点"变成北京时间 10 点。

```yaml
timeZone: "Asia/Shanghai"
```

**② 并发策略**

| 值 | 行为 |
| --- | --- |
| `Allow`（默认） | 上一次没跑完，下一次照常启动 → 可能同时跑两个 |
| `Forbid` | 上一次还在跑就跳过本次 |
| `Replace` | 杀掉上一个，启动新的 |

**必须显式设置**：默认 `Allow` 是"任务重叠"事故的主要来源。

**③ startingDeadlineSeconds**

控制器如果有一段时间没工作（比如重启），错过的调度点会怎样？设了 `startingDeadlineSeconds` 就只在截止时间内补跑，否则可能**一次性补跑很多次**。

**④ 历史保留**

```yaml
successfulJobsHistoryLimit: 3
failedJobsHistoryLimit: 3
```

默认成功保留 3、失败保留 1，不调会让 etcd 里堆积大量 Job 对象。

**⑤ 不要用 CronJob 做精确定时**

CronJob 的精度受控制器调度周期影响，误差可达分钟级。需要秒级精度的任务，用外部调度器（如 Temporal、业务内定时器）。

### 批处理任务的三个工程要求

1. **可断点续跑**：任务跑在 2 小时处失败，重跑不该从 0 开始。
2. **幂等**：输出按 key 覆盖写，不要 append。
3. **有进度与心跳**：日志里定期打 `processed=12000/50000`，方便判断"是慢还是卡住"。

```python
if i % 1000 == 0:
    log.info("progress", extra={"processed": i, "total": total})
```

### 排查清单

```
□ 任务一直 Pending → 资源不足 / 节点亲和性 / 镜像拉取失败
□ 任务反复重试 → 看 backoffLimit 与任务退出码
□ 任务跑两次 → 检查幂等性与 restartPolicy
□ CronJob 没触发 → 看 timeZone、suspend、schedule 语法
□ CronJob 重叠 → 检查 concurrencyPolicy
□ Pod 堆积 → 加 ttlSecondsAfterFinished
```
