---
title: 第 7 章：监控与日志：集群侧要盯什么
module: 熟练篇
summary: 四类对象（节点/工作负载/集群组件/业务）、关键指标与阈值、事件与日志采集、五个"监控装了但故障看不见"的原因。
minutes: 50
---

### 四类监控对象

```
① 节点：CPU/内存/磁盘/inode/网络
② 工作负载：副本可用、重启次数、OOM
③ 集群组件：apiserver/etcd/scheduler/CNI
④ 业务：QPS/延迟/错误率
```

**"只监控节点"** → Pod 崩溃、调度失败都看不见。

### 节点侧关键指标

```
node_filesystem_avail_bytes      剩余空间（按挂载点）
node_filesystem_files_free       inode
node_load1                       负载
node_memory_MemAvailable_bytes   可用内存
node_network_receive_errs_total  网卡错误
```

**阈值建议**：

```
磁盘 80% 警告 / 90% 严重
inode 85% 警告
load1 > 核数 × 2 持续 10 分钟 → 告警
```

### 工作负载侧

```promql
# 不可用副本
kube_deployment_status_replicas_unavailable > 0
# 重启次数（15 分钟内）
increase(kube_pod_container_status_restarts_total[15m]) > 3
# OOM
increase(kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}[10m]) > 0
```

**"只看 Pod 状态"** → 反复重启但总能起来的情况会被漏掉。

### 集群组件

```promql
# apiserver 延迟
histogram_quantile(0.99, sum(rate(apiserver_request_duration_seconds_bucket[5m])) by (le)) > 1
# etcd fsync 延迟
histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])) > 0.5
# 调度 Pending
kube_pod_status_phase{phase="Pending"} > 0
```

**etcd fsync > 500ms** → 磁盘是瓶颈（会引发集群整体变慢）。

### 事件（Events）

```bash
kubectl get events -A --sort-by=.lastTimestamp | tail -30
kubectl events --types=Warning -A
```

**事件是"最短命的证据"**（默认保留 1 小时）→ 要采集进日志平台。

### 日志采集

```
① 容器日志：stdout/stderr 由运行时落到节点
② 采集：Promtail/Fluent Bit/Vector（DaemonSet）
③ 汇聚：Loki/ES
④ 关键：带 pod/namespace/container 标签
```

```yaml
# 采集侧要有 meta 标签，否则无法按服务过滤
- match: kubernetes.*
  labels: {app: ${pod_name}}
```

### 五个"监控装了但故障看不见"

**① 只监控节点**

```
Pod 崩溃循环不在节点指标里
```

**② 没有业务指标**

```
节点全绿但错误率 50%
```

**③ 事件没采集**

```
"为什么 Pending" 只能靠猜
```

**④ 告警阈值是默认值**

```
每个集群容量不同，默认阈值全是噪音
```

**⑤ 缺少"集群组件"**

```
etcd 慢 → 全集群诡异变慢，但没人看
```

### 本章检查清单

```
□ 节点：磁盘/inode/负载/内存
□ 工作负载：可用副本/重启/OOM
□ 集群组件：apiserver/etcd/scheduler
□ 业务：QPS/延迟/错误率
□ Events 采集进日志平台
□ 日志带 k8s 元数据标签
□ 阈值按集群容量设定
□ 告警分级且可行动
□ 有 Dashboard（节点/服务/集群各一）
□ 有"故障注入"验证监控有效
```
