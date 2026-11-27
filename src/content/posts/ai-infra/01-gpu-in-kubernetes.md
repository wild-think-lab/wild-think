---
title: GPU 怎么进 Kubernetes：一条版本链上的五个环节
description: 裸机上的 GPU 到 Pod 里的 GPU，中间隔着驱动、运行时、device plugin、Operator 四层。任何一层版本错位，都会表现成"nvidia-smi 不存在"。
date: 2026-11-27
tags: [GPU, Kubernetes, CUDA, device-plugin, AI基础设施]
featured: true
---

### 五个环节，缺一环就报错

```
物理 GPU
  ↓ ① 内核驱动（nvidia.ko）
宿主机 /dev/nvidia*
  ↓ ② 容器运行时（nvidia-container-toolkit / CDI）
容器能看到 GPU
  ↓ ③ device plugin（nvidia/k8s-device-plugin）
K8s 能调度 "nvidia.com/gpu"
  ↓ ④ Operator（gpu-operator）
自动装驱动、开 MIG、拉起 DCGM 监控
  ↓ ⑤ 工作负载（训练/推理 Pod）
```

新手最常见的困惑："`nvidia-smi` 在宿主机正常，容器里没有" —— 断在第②环；"容器里有 `nvidia-smi`，但 Pod 调度不到 GPU" —— 断在第③环。

### ① 驱动与 CUDA 的版本关系

必须先搞清三个版本：

| 名字 | 谁决定 | 约束 |
| --- | --- | --- |
| 驱动版本（`nvidia-smi` 右上角） | 宿主机 | 决定能支持的最高 CUDA |
| CUDA Runtime 版本 | 容器镜像 | 不能超过驱动支持上限 |
| cuDNN / 框架版本 | 镜像 | 依赖具体 CUDA 版本 |

用 `nvidia-smi` 看 `CUDA Version: 12.4` 表示**驱动支持到 12.4**，不是装了什么。镜像里 `nvcc --version` 才是运行时版本。

镜像选型口诀：**按宿主机驱动上限去选镜像，不要反过来升驱动就为追新镜像**（生产机器升级驱动要考虑内核匹配与在跑的容器）。

### ② 让容器看到 GPU

```bash
# Debian/Ubuntu
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 验证
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

K8s 侧（containerd）需要配 `nvidia-container-runtime`，或启用 CDI：

```bash
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
```

容器里 `nvidia-smi` 报 "No devices were found"，通常是 runtime 没配或 `/dev/nvidia*` 没挂进去。

### ③ device plugin：把 GPU 变成可调度资源

```bash
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.16.2/deployments/static/nvidia-device-plugin.yml
kubectl get nodes -o json | jq '.items[].status.capacity'
# 期望看到 "nvidia.com/gpu": "8"
```

Pod 申请：

```yaml
resources:
  limits:
    nvidia.com/gpu: 1
```

注意三点：

- GPU **只能写在 `limits`**，写 `requests` 无效（整卡不可分割，除非开 MIG）。
- `nvidia.com/gpu: 1` 表示整卡独占，不是"1% 算力"。
- 没有 device plugin 时，`limits` 写什么都不生效，Pod 起来但看不到卡。

### ④ MIG：把 A100/H100 切成小块

A100 40G 可切成 7 份（如 `1g.5gb`），让多个小推理任务共享一张卡。

```bash
# 宿主机上开启（需 Ampere 及以上、特定型号）
sudo nvidia-smi -mig 1
nvidia-smi mig -cgi 1g.5gb,1g.5gb -C    # 建两个实例
nvidia-smi mig -lgi                    # 查看
```

K8s 侧开 MIG 后，device plugin 会把 `nvidia.com/mig-1g.5gb` 作为可调度资源。

生产建议：**训练不用 MIG（要整卡带宽），推理可以**；MIG 实例数量变更必须停掉所有相关 Pod，别在跑任务时改。

### ⑤ GPU Operator：把以上都自动化

```bash
helm repo add nvidia https://helm.nvidia.com/releases
helm install gpu-operator nvidia/gpu-operator -n gpu-operator --create-namespace \
  --set driver.enabled=true \
  --set toolkit.enabled=true \
  --set dcgmExporter.enabled=true \
  --set migManager.enabled=true
```

它管理的组件：驱动容器、container-toolkit、device plugin、DCGM exporter、MIG manager、validator。

裸金属装机不建议用 Operator 管驱动（它会重装驱动，可能和宿主内核冲突）；**K8s 节点批量部署时才值得**。

### 监控：DCGM 才是正经指标

```bash
kubectl get pods -n gpu-operator | grep dcgm
```

DCGM 暴露的关键指标（Prometheus）：`DCGM_FI_DEV_GPU_UTIL`、`DCGM_FI_DEV_MEM_COPY_UTIL`、`DCGM_FI_DEV_FB_USED`（显存）、`DCGM_FI_DEV_GPU_TEMP`、`DCGM_FI_DEV_XID_ERRORS`。

**必须告警的两条**：显存使用 > 90%（OOM 前兆）、XID 错误（硬件级故障，如 XID 79 掉卡）。

### 常见故障对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 容器里 `nvidia-smi` 不存在 | runtime 没配 | 配 nvidia-container-runtime / CDI |
| `Failed to initialize NVML` | 驱动与容器内版本不匹配 | 对齐驱动与 CUDA |
| Pod Pending，`nvidia.com/gpu` 不足 | 卡被别的 Pod 占了 | `kubectl describe` 看 Allocated |
| 训练随机 CUDA error | ECC 错误或卡过热 | `nvidia-smi -q -d ECC,TEMPERATURE` |
| 显存不足 OOM | batch 太大 / 未释放缓存 | 降 batch，检查是否有残留进程 |

### 一句话总结

GPU 进 K8s 的所有问题，本质都是**版本链断在某处**。定位方法固定：宿主机 `nvidia-smi` → 容器 `--gpus all` → Pod `limits` → 调度状态。逐环验证，不要跳。
