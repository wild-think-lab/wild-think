---
title: 一次真实的 K8s 故障排查：Pod 一直在重启
description: 从告警到定位的完整路径：CrashLoop、OOMKilled、探针误杀、节点资源不足四类问题怎么区分，以及该留哪些现场。
date: 2026-11-27
tags: [Kubernetes, 排障, 运维, OOM]
---

### 故障现场

监控告警：`web-7d9f8c-xxxx` 在 20 分钟内重启 14 次。业务侧反馈"下单页偶尔 502"。

拿到这种问题，不要先猜代码。按固定顺序走：

```bash
kubectl get pods -n prod | grep -v Running
kubectl describe pod web-7d9f8c-xxxx -n prod | sed -n '/Events/,$p'
```

`describe` 的 Events 段几乎总能给出方向：

- `Back-off restarting failed container` → 容器内进程退出。
- `OOMKilled` → 内存超 limits 被杀。
- `Liveness probe failed` → 探针失败触发重启。
- `FailedScheduling` → 根本没跑起来，跟重启无关。

### 第一类：进程真的崩了

```bash
kubectl logs web-7d9f8c-xxxx -n prod --previous --tail=100
```

`--previous` 是关键——当前容器可能刚起来还没日志，崩掉的那个实例的日志才是有用的。

常见原因按概率排：

1. 配置缺失（环境变量没注入、ConfigMap 里少了 key）——日志多为 `KeyError`、`config not found`。
2. 依赖服务不可达（数据库连不上）——`connection refused` / `timeout`。
3. 启动时读文件权限不足（挂载卷 UID 不对）——`permission denied`。
4. 迁移脚本失败（数据库版本不匹配）。

修复方向是配置，不是重启次数。

### 第二类：OOMKilled

```bash
kubectl describe pod <pod> | grep -A2 'Last State'
# Last State: Terminated  Reason: OOMKilled  Exit Code: 137
```

exit code 137 = 128 + 9 = SIGKILL，通常就是内存超限。

判断是"limits 设太小"还是"程序真漏内存"：

```bash
kubectl top pod <pod> --containers          # 实时占用
kubectl get pod <pod> -o jsonpath='{.spec.containers[*].resources}'
```

如果占用曲线是持续爬升 → 泄漏，改代码；如果一启动就冲到 limits → limits 太小或 JVM/Go 堆参数没随 limits 调整。

**Java 特有坑**：容器内 JVM 若未开启 `UseContainerSupport`（新版本默认开）或用老版本参数 `-Xmx` 写死大于 limits，会被 cgroup 直接杀，且看不到任何 Java OOM 日志。设置 `-XX:MaxRAMPercentage=75` 更安全。

### 第三类：探针误杀

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 8080 }
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 1
  failureThreshold: 3
```

三个高频错误：

- `initialDelaySeconds` 太小：应用启动要 30 秒，5 秒就开始探活 → 必被杀。
- `timeoutSeconds: 1` 太紧：GC 或冷启动时一次响应慢就被判死。
- liveness 里查了数据库：数据库抖一下，整个应用被重启，把一次小故障放大成雪崩。

**规范做法**：liveness 只查"进程是否卡死"（本地自检），readiness 才查依赖（DB、下游服务）。liveness 触发重启是不可逆的破坏性动作，必须极度保守。

### 第四类：节点资源与调度

```bash
kubectl describe node <node> | sed -n '/Allocated resources/,$p'
kubectl get pod <pod> -o jsonpath='{.status.conditions}'
```

节点 Allocatable 被 requests 打满时，新 Pod 会 Pending。此时看：

- 是否有大 Pod 的 `requests` 写得离谱（比如 `cpu: 4` 实际只用 0.2）。
- 是否有节点被打上污点（`Taints`）。
- 是否 PVC 没绑定成功（`PersistentVolumeClaim is not bound`）。

### 定位后的处置顺序

1. **先止血**：回滚 `kubectl rollout undo deploy/web -n prod`，比定位快。
2. **留现场**：`kubectl describe`、`logs --previous`、`kubectl get events` 全部存档，别急着删 Pod。
3. **改根因**：配置、limits、探针参数，改完写进 Git。
4. **补监控**：重启次数、OOM 次数、探针失败率都应该有告警。

### 该常备的几个命令

```bash
kubectl get pods -A --field-selector=status.phase!=Running
kubectl get events -A --sort-by=.lastTimestamp | tail -20
kubectl rollout history deploy/web -n prod
kubectl rollout undo deploy/web -n prod --to-revision=3
kubectl exec -it <pod> -n prod -- sh -c 'cat /proc/1/status | head -5'
```

K8s 排障的核心不是记命令，而是**先分清"没跑起来"和"跑起来又挂了"**。前者看调度与镜像，后者看日志与退出码。方向对了，剩下的都是细节。
