---
title: GPU 驱动与 CUDA 基础：nvidia-smi 之外的八个命令
description: 驱动与 CUDA 的关系、版本矩阵怎么对、五个常见"显卡在但用不了"的原因。
date: 2025-02-28
tags: [AI, GPU, CUDA]
---

### 四层依赖关系

```
硬件 → 驱动（内核模块） → CUDA Toolkit（运行时/编译器） → 框架（PyTorch/TF）
```

**"框架要的 CUDA 版本 ≤ 驱动支持的版本"** —— 这是唯一硬约束。

### 版本矩阵怎么对

```bash
nvidia-smi          # 右上角 CUDA Version = 驱动支持的"最高"CUDA
nvcc -V             # 实际安装的 CUDA Toolkit 版本
python -c "import torch; print(torch.version.cuda, torch.cuda.is_available())"
```

**理解**：

```
nvidia-smi 的 "CUDA Version: 12.4" = 驱动能跑 CUDA 12.4 及以下的程序
实际跑的版本看 nvcc / torch.version.cuda
```

**"nvidia-smi 显示 12.4，nvcc 显示 11.8，torch 用 11.8"** → 完全正常（向下兼容）。

### 八个必会命令

```bash
nvidia-smi                              # 总览
nvidia-smi -q                           # 详细（ECC/温度/功耗）
nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv
nvidia-smi -L                           # GPU 与 MIG 列表
nvidia-smi pmon -c 1                    # 每卡的进程与利用率
nvidia-smi dmon                         # 时间序列（类似 iostat）
nvidia-smi topo -m                      # 拓扑（NVLink/PCIe 路径）
nvidia-smi -pl 250                      # 限制功耗（瓦）
```

**`topo -m`** 是"为什么多卡训练慢"的关键工具：

```
NVLink 连接的两卡通信快
跨 NUMA/跨 PCIe Switch 的慢（NCCL 会绕远路）
```

### 显存诊断

```bash
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
```

**"显存被占但 nvidia-smi pmon 无进程"**：

```
① 僵尸进程（进程已死，显存未释放）→ 需要清进程/重启
② 另一个用户/容器占用（容器内看不到）
③ ECC 保留显存
```

### 五个"显卡在但用不了"

**① 驱动没装 / 版本太老**

```bash
lsmod | grep nvidia
nvidia-smi     # "NVIDIA-SMI has failed because it couldn't communicate with the driver"
```

**常见原因**：

```
① 内核升级后 DKMS 没重新编译
② Secure Boot 阻止未签名模块加载
③ 容器内没挂载设备（--gpus all 缺失）
```

**② 容器里看不到 GPU**

```bash
docker run --rm --gpus all nvidia/cuda:12.4-base nvidia-smi
```

**需要**：

```
① 宿主机装了 nvidia-container-toolkit
② 运行时配置了 nvidia runtime
```

**③ 版本不匹配**

```
torch 装的是 cu121，驱动只支持到 11.x → "no kernel image available"
```

**④ ECC 或功耗限制导致性能异常**

```bash
nvidia-smi -q | grep -A3 ECC
nvidia-smi -q -d PERFORMANCE
```

**"算力只有一半"** → 检查是否触发功耗/温度降频（`clocks_throttle_reasons`）。

**⑤ 多卡训练"没用上 NVLink"**

```bash
nvidia-smi topo -m
# 看到 PCIe 而不是 NVLink → 通信成瓶颈
```

### 容器与 K8s 场景

```bash
# docker
docker run --gpus '"device=0,1"' ...
# k8s（nvidia device plugin）
resources:
  limits:
    nvidia.com/gpu: 2
```

**"申请了 2 卡但只能看到 1 卡"**：

```
① device plugin 未部署
② 资源名写错（nvidia.com/gpu 不是 gpu）
③ MIG 场景下资源名不同（nvidia.com/mig-1g.5gb）
```

### 一个"健康检查"脚本

```bash
#!/usr/bin/env bash
nvidia-smi -L || exit 1
nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu \
  --format=csv,noheader
nvidia-smi -q -d PERFORMANCE | grep -i "clocks_throttle_reasons.active" -A8
```

**上线前跑一次，把"卡是好的"作为前提**。

### 检查清单

```
□ 驱动已装且内核升级后仍正常（DKMS）
□ nvidia-smi / nvcc / torch.version.cuda 三者关系清楚
□ 容器有 nvidia-container-toolkit
□ K8s 有 device plugin 且资源名正确
□ 会看 topo（NVLink vs PCIe）
□ 会查显存占用进程
□ 会看降频原因
□ 有 GPU 健康检查脚本
□ 功耗/温度有监控（避免降频）
□ 驱动/CUDA 版本在文档里固定下来
```
