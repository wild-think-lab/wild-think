---
title: K8s 里的 GPU：调度、共享与利用率幻觉
description: 为什么 GPU 利用率常年只有 20%、三种共享方案（MIG/时间片/vGPU）、调度约束与显存不足的排查。
date: 2026-11-27
tags: [Kubernetes, GPU, AI, 调度]
---

### 先看一个现实

```
买了 8 张 A100，K8s 里跑推理服务
nvidia-smi 显示 GPU 利用率平均值 18%
→ 钱花了 8 张，用出 1.5 张的效果
```

**GPU 利用率低是 AI 集群最贵的浪费**。

### 三个原因

```
① 显存占用高但算力利用率低（模型加载完就占着显存）
② 请求稀疏（在线推理低峰期没有流量）
③ 一个 Pod 独占整卡（哪怕它只用 10GB 显存、20% 算力）
```

**K8s 的默认行为是③**：`nvidia.com/gpu: 1` 表示"整卡独占"，不可分割。

### 三种共享方案

| 方案 | 隔离级别 | 显存隔离 | 需要什么 |
| --- | --- | --- | --- |
| MIG（多实例） | 硬件分区 | 是（硬隔离） | A100/H100 等支持 MIG 的卡 |
| 时间片共享 | 软共享（无显存隔离） | 否 | 默认支持（`nvidia.com/gpu` 可超卖） |
| vGPU | 硬件虚拟化 | 是 | NVIDIA vGPU 授权 + 支持的卡 |

**MIG 是"最正经"的方案**：

```
A100 80GB 可以切成 7 个 10GB 实例（或 2×40GB 等组合）
每个实例有独立显存与算力分区
→ 可以给 7 个 Pod 用，互不影响
```

**时间片共享的实现**：

```yaml
# 1. 让节点上报"可共享"的资源
# configmap 里配置（DCGM-exporter / device-plugin 的共享策略）
# 2. 声明使用共享
resources:
  limits:
    nvidia.com/gpu: 1
    nvidia.com/gpu.shared: 1     # 共享模式
```

**注意**：时间片共享**没有显存隔离**，一个 Pod 显存打爆会 OOM 掉同卡的其他 Pod。

### 调度约束

```yaml
spec:
  containers:
  - name: infer
    resources:
      limits:
        nvidia.com/gpu: 2          # 2 张整卡
  nodeSelector:
    gpu-type: a100
  tolerations:
  - key: nvidia.com/gpu
    operator: Exists
    effect: NoSchedule
```

**GPU 节点通常打污点**（避免普通 Pod 占资源）：

```bash
kubectl taint nodes gpu-node-1 nvidia.com/gpu=present:NoSchedule
```

**关键约束**：

```
- GPU 资源只能是整数（不能 0.5 张卡），除非用共享方案
- GPU 资源必须在 limits 里（requests 可不写，会自动等于 limits）
- 不能超卖（除非开了共享）
```

### 利用率幻觉：为什么监控显示 90% 却没产出

```
有些监控把 "GPU 有进程占用" 当成 "利用率"
实际 SM（流处理器）利用率可能只有 15%
```

**要看对指标**：

```bash
# DCGM 的指标（推荐）
DCGM_FI_DEV_GPU_UTIL         # SM 利用率
DCGM_FI_DEV_MEM_COPY_UTIL    # 显存带宽利用率
DCGM_FI_DEV_FB_USED          # 显存使用（MB）
DCGM_FI_DEV_POWER_USAGE      # 功耗（最诚实：功耗低=真没用）
```

**功耗是最好的"真相指标"**：

```
A100 满载约 250W，空闲约 50W
如果显示 60W，那"90% 利用率"是假的
```

### 显存不足（OOM）的排查

```bash
# 看节点上的 GPU 情况
nvidia-smi
nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv

# 看谁在用
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv

# 在 Pod 里
kubectl exec -it <pod> -- nvidia-smi
```

**常见原因**：

```
① 模型本身超显存（量化或换小模型）
② batch size 太大（调小）
③ 显存碎片（PyTorch 的 caching allocator，设 PYTORCH_CUDA_ALLOC_CONF）
④ 多进程各自加载一份模型（用共享内存或统一服务）
```

**PyTorch 显存碎片处理**：

```bash
export PYTORCH_CUDA_ALLOC_CONF=max_split_size_mb:128
```

### 部署 GPU 环境的四步

```bash
# 1. 节点装驱动（版本要与 CUDA 匹配）
nvidia-smi

# 2. 装 NVIDIA Container Toolkit
nvidia-ctk --version

# 3. 部署 device-plugin（让 K8s 看到 GPU）
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/main/deployments/static/nvidia-device-plugin.yml

# 4. 部署 DCGM-exporter（监控）
# 通常用 GPU Operator 一把装完
```

**GPU Operator** 把驱动、toolkit、device-plugin、DCGM 全打包了，推荐用它：

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm install gpu-operator nvidia/gpu-operator -n gpu-operator --create-namespace
```

**注意**：GPU Operator 默认会自己装驱动（可能与宿主已装的驱动冲突）。已有驱动的节点要设 `driver.enabled=false`。

### 一个"提高利用率"的实际做法

**① 在线推理用小卡 + 共享**

```
低峰期：多个模型共享一张卡（时间片）
高峰期：各自独占
```

**② 离线批处理排队**

```
把所有离线任务放一个队列（如 Volcano/Kueue）
有卡就调度，没卡就等
→ 比"每个任务申请一张卡然后闲置"利用率高得多
```

**③ 保证 GPU 不被"占着不用"**

```
设 GPU 空闲超时（进程 30 分钟无请求 → 释放）
或用 serverless 推理（按请求起停，冷启动换利用率）
```

**④ 用 MIG 做小模型**

```
7B 以下的模型用 10GB MIG 实例足够
一张 A100 可以跑 7 个
```

### 检查清单

```
□ 节点有驱动 + toolkit + device-plugin
□ 有 DCGM 监控（含功耗与显存）
□ GPU 节点打了污点
□ 明确是整卡独占还是共享
□ 共享方案有显存隔离（否则会互相 OOM）
□ 离线任务走队列（不各自占卡）
□ 有空闲检测与释放机制
□ PyTorch 显存碎片参数（如需要）
□ 用功耗判断真实利用率
```
