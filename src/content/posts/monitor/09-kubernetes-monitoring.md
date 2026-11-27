---
title: 集群监控：kube-state-metrics 之外你还缺什么
description: 集群监控的四类数据、kube-state-metrics 能给你什么、节点与容器的指标怎么采、三类必配告警，以及"节点 NotReady"的排查顺序。
date: 2023-11-27
tags: [Kubernetes, 监控, Prometheus, 指标]
---

### 四类数据

```
① 集群对象状态（kube-state-metrics）：Deployment 副本数、Pod 重启、PVC 状态
② 容器资源（cAdvisor / kubelet）：CPU、内存、网络、磁盘
③ 节点资源（node_exporter）：磁盘、inode、网络、负载
④ 应用自身（业务 exporter）：QPS、延迟、错误率
```

**只采 ②④ 会漏掉"对象级故障"**（比如 Deployment 卡在 0 副本，容器指标看不出来）。

### kube-state-metrics 给什么

部署：

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install ksm prometheus-community/kube-state-metrics -n monitoring
```

有价值的指标：

| 指标 | 用途 |
| --- | --- |
| `kube_deployment_status_replicas_unavailable` | 副本不足（滚动更新卡住） |
| `kube_pod_container_status_restarts_total` | 重启次数（CrashLoop） |
| `kube_pod_status_phase{phase="Pending"}` | 调度失败 |
| `kube_node_status_condition{condition="Ready",status="true"}` | 节点是否就绪 |
| `kubelet_volume_stats_available_bytes` | PVC 剩余空间 |
| `kube_job_status_failed` | CronJob 失败 |

三个必备查询：

```promql
# 副本不足的 Deployment
kube_deployment_status_replicas_unavailable > 0

# 5 分钟内重启超过 3 次的 Pod
increase(kube_pod_container_status_restarts_total[5m]) > 3

# PVC 使用率 > 85%
kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes > 0.85
```

### 节点指标（node_exporter）

关键项：

| 指标 | 告警线 |
| --- | --- |
| `node_filesystem_avail_bytes`（根分区） | < 15% |
| `node_filesystem_files_free`（inode） | < 10% |
| `node_load15` | > 核数 × 0.8 |
| `node_memory_MemAvailable_bytes` | < 10% |
| `node_network_receive_errs_total` | 持续增长 |

**K8s 节点最容易死在"磁盘满"和"inode 满"**，两者都要监控。

### 容器指标（cAdvisor）

```yaml
# kubelet 自带 cAdvisor，Prometheus 抓 https://<node>:10250/metrics/cadvisor
- job_name: 'kubelet'
  scheme: https
  bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
  tls_config: { insecure_skip_verify: true }
  kubernetes_sd_configs:
  - role: node
```

常见查询：

```promql
# 容器内存使用（排除缓存）
container_memory_working_set_bytes{container!=""}

# CPU 使用率
rate(container_cpu_usage_seconds_total{container!=""}[5m])

# 容器 OOM
container_oom_events_total
```

### 三类必配告警

**① 对象级**

```
- Deployment 副本不足 → warning
- Pod 重启 > 3 次/5min → warning
- Pod 长时间 Pending → warning
- CronJob 连续失败 → warning
```

**② 节点级**

```
- 节点 NotReady → critical
- 磁盘使用 > 85% → warning
- 内存可用 < 10% → warning
- kubelet 不响应 → critical
```

**③ 容量级**

```
- 节点 Pod 数量接近上限（默认 110）
- PVC 使用 > 85%
- 集群有未调度的 Pod 持续 10 分钟
```

### "节点 NotReady"排查顺序

```bash
# 1. 节点状态与原因
kubectl describe node <node> | grep -A 10 Conditions

# 2. kubelet 状态
systemctl status kubelet
journalctl -u kubelet -n 100 --no-pager | grep -i 'error\|fail'

# 3. 常见原因逐项
df -h; df -i                       # 磁盘/inode 满
free -m                            # 内存耗尽
systemctl status containerd        # 容器运行时挂了
journalctl -u containerd -n 50     # 运行时错误

# 4. 网络
crictl ps                          # 能否列出容器
ping <apiserver>
```

四个最常见原因：

| 原因 | 特征 |
| --- | --- |
| 磁盘满 | `df -h` 根分区 100%，kubelet 报 `Disk pressure` |
| 内存耗尽 | 大量 Pod 被驱逐 |
| containerd 挂 | `crictl ps` 失败 |
| 时钟漂移 | 证书校验失败 |

**kubelet 有一个"驱逐阈值"**：磁盘可用低于 10% 就会开始驱逐 Pod，这是 NotReady 的常见前兆。

### 监控自身的监控

```
Prometheus 自己挂了，所有告警都失效。
必须有：
① 外部探活（另一个系统探测 Prometheus /-/healthy）
② Alertmanager 有心跳（watchdog 告警，永远触发，收到说明链路通）
③ 告警发送通道的可用性监控
```

Alertmanager 的 watchdog：

```yaml
- alert: Watchdog
  expr: vector(1)
  labels: { severity: none }
  annotations: { summary: "告警链路心跳" }
```

**每 24 小时收到一条 watchdog 告警，说明链路是通的**；收不到就说明告警系统本身坏了。

### 检查清单

```
□ kube-state-metrics 已部署
□ 节点：磁盘、inode、内存、负载都有监控
□ 容器：CPU、内存、OOM、重启有监控
□ 三类告警都配了（对象/节点/容量）
□ Prometheus 自身有外部探活
□ 有 watchdog 心跳告警
□ 知道"节点 NotReady"的排查顺序
```
