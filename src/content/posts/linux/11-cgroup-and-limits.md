---
title: cgroup v2 与资源限制：容器被 OOM 杀掉的真正原因
description: cgroup v1/v2 的差异、memory/cpu/io 三个控制器的关键文件、requests 与 limits 的实际映射，以及"内存没超也 OOM"的解释。
date: 2023-05-18
tags: [Linux, cgroup, 容器, 资源限制]
---

### cgroup 在做什么

```
cgroup = 把一组进程的 CPU / 内存 / IO / 进程数 限制在一个额度内
v1：每类资源一个独立的层级树（cpu、memory、blkio 各自一棵）
v2：统一成一棵树，用 controller 文件控制
```

查看当前系统：

```bash
stat -fc %T /sys/fs/cgroup
# cgroup2fs → v2
# tmpfs → v1
```

### v2 的关键目录

```bash
ls /sys/fs/cgroup/
# cgroup.controllers       可用控制器
# cgroup.procs             当前组的进程
# memory.max               内存硬限
# memory.current           当前用量
# memory.stat              细分统计
# cpu.max                  CPU 配额（如 "200000 100000" = 2 核）
# io.max                   块设备限速
# pids.max                 进程/线程数上限
```

### 内存：为什么会 OOM

**memory.max 是"硬限"**：超过就触发 OOM killer（杀组内进程）。

```bash
cat /sys/fs/cgroup/<group>/memory.max
cat /sys/fs/cgroup/<group>/memory.current
cat /sys/fs/cgroup/<group>/memory.stat | grep -E 'anon|file|slab'
```

关键区别：

| 项目 | 含义 | 是否算入限制 |
| --- | --- | --- |
| `anon` | 匿名内存（堆、栈） | **算** |
| `file` | 页缓存（读文件） | **算，但可回收** |
| `slab` | 内核对象 | 算 |
| `kernel_stack` | 内核栈 | 算 |

**"内存没超也 OOM" 的三种解释**：

1. **页缓存占了额度**：`memory.current` 里有大量 `file`，虽然可回收，但回收速度跟不上分配速度（瞬时高峰）。
2. **没有设 swap**：`memory.swap.max=0` 时，匿名内存无处可去。
3. **统计滞后**：`memory.current` 是周期采样，实际瞬时可能已超。

排查：

```bash
# 容器内看（cgroup 视角，比 free 准确）
cat /sys/fs/cgroup/memory.stat
cat /sys/fs/cgroup/memory.events      # oom / oom_kill 计数
```

`memory.events` 里的 `oom_kill` 是"真的被杀过几次"。

### CPU：quota 与 shares

```bash
cat /sys/fs/cgroup/cpu.max      # "200000 100000" = 2 核（200ms/100ms）
cat /sys/fs/cgroup/cpu.stat     # 含 throttled_usec（被限流的时长）
```

**两种限制方式的差别**：

| 机制 | 作用 | K8s 对应 |
| --- | --- | --- |
| `cpu.max`（quota） | **硬上限**，超了就被 throttle | `limits.cpu` |
| `cpu.weight`（shares） | 竞争时的相对权重 | `requests.cpu` |

**关键理解**：

```
requests 不限制使用，只保证"竞争时有这么多"
limits 是真上限，超了会被 CFS throttle（表现为延迟抖动）
```

**throttling 的表现**：CPU 使用率看起来不高（比如 40%），但延迟很高 → 因为被周期性地"掐断"。

```bash
cat /sys/fs/cgroup/cpu.stat
# nr_throttled: 1234
# throttled_usec: 5678900
```

`nr_throttled` 持续增长 = 被限流了。这是"CPU 没满但很慢"的常见原因。

### IO 限制

```bash
# 限制设备 8:0 的读写速率（字节/秒）与 IOPS
echo "8:0 rbps=104857600 wbps=52428800 riops=1000 wiops=500" > /sys/fs/cgroup/io.max
```

**注意**：`io.max` 只对**直接 IO**（`O_DIRECT`）效果好，buffered IO 会被页缓存"绕过"限额。

K8s 里用 `blkio` 限制时，这个问题同样存在：**写缓存多时限制不住**。

### K8s 里的映射

```yaml
resources:
  requests: { cpu: 500m, memory: 512Mi }
  limits:   { cpu: "1",  memory: 1Gi }
```

实际生成：

```
requests.cpu 500m  → cpu.weight（换算成相对权重）
limits.cpu 1       → cpu.max "100000 100000"
requests.memory    → 调度依据（不写 cgroup）
limits.memory 1Gi  → memory.max
```

**只写 limits 不写 requests 的后果**：调度器按 limits 算资源占用（相当于 requests=limits），节点容易被"超卖"。

### QoS 等级

| 等级 | 条件 | 被驱逐顺序 |
| --- | --- | --- |
| Guaranteed | requests == limits（cpu 与 memory 都相等） | 最后 |
| Burstable | requests < limits | 中间 |
| BestEffort | 都没设 | 最先 |

**关键服务用 Guaranteed**（保证不被优先驱逐）。

### 一个真实的 OOM 排查

**现象**：Java 服务 Pod 反复重启，`kubectl describe` 显示 `OOMKilled`，但 `kubectl top` 显示内存只用了 60%。

**排查**：

```bash
# 1. 容器内 cgroup 视角
kubectl exec <pod> -- cat /sys/fs/cgroup/memory.stat
# anon 800MB, file 300MB，memory.max 设为 1Gi

# 2. JVM 堆设置
java -XX:+PrintFlagsFinal -version | grep MaxHeapSize
# MaxHeapSize ≈ 1.5G   ← 超过容器限额！
```

**根因**：JVM 没感知容器限额（老版本 JDK 或没开 `UseContainerSupport`），按宿主机内存算堆大小，堆 + 元空间 + 直接内存 > 1Gi → OOM。

**修复**：

```dockerfile
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70 -XX:+UseContainerSupport"
```

70% 是经验值：留 30% 给元空间、线程栈、直接内存、页缓存。

### 检查清单

```
□ 确认是 cgroup v1 还是 v2
□ 关键服务 requests == limits（Guaranteed）
□ memory.events 的 oom_kill 有监控
□ cpu.stat 的 nr_throttled 有监控（CPU 未满但慢的信号）
□ JVM/Go 应用感知容器限额
□ 有 swap 或明确禁用（不要含糊）
□ 知道 io.max 对 buffered IO 限制不住
```
