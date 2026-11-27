---
title: vLLM 推理服务：显存、吞吐与"为什么批量大了反而慢"
description: PagedAttention 的原理、关键参数怎么调、显存怎么算、以及五个上线后必然遇到的性能问题。
date: 2026-11-27
tags: [AI基础设施, vLLM, 推理, GPU]
---

### 它解决什么问题

```
朴素推理：KV Cache 预分配固定大小 → 显存浪费严重 → 并发上不去
vLLM    ：PagedAttention（KV Cache 分页管理）→ 显存利用率高 → 吞吐提升数倍
```

**核心指标**：

```
TTFT（Time To First Token）：首字延迟（用户感知的"响应速度"）
TPOT / ITL（每 token 间隔）   ：生成速度（流式输出的顺滑度）
吞吐（tokens/s）              ：总处理能力（成本相关）
```

**三者互相拉扯**：批量大吞吐高，但 TTFT/TPOT 变差。

### 关键参数

```bash
vllm serve /models/Qwen2.5-7B-Instruct \
  --tensor-parallel-size 1 \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.90 \
  --max-num-seqs 256 \
  --max-num-batched-tokens 8192 \
  --enable-prefix-caching \
  --dtype bfloat16
```

**逐个解释**：

```
--tensor-parallel-size     ：张量并行数（= 用几张卡跑同一个模型）
--max-model-len            ：最大上下文（显存占用随它线性增长）
--gpu-memory-utilization   ：显存使用上限（0.9 是常见值，留 10% 给碎片）
--max-num-seqs             ：同时处理的请求数上限（并发）
--max-num-batched-tokens  ：一个 batch 里最多的 token 数（吞吐核心）
--enable-prefix-caching    ：相同前缀复用 KV Cache（对话场景收益极大）
```

### 显存怎么算（最关键的一步）

```
总显存 = 模型权重 + KV Cache + 激活 + 框架开销
```

**模型权重**：

```
7B 模型，bf16（2 字节/参数）= 14GB
7B 模型，int8 量化 ≈ 7GB
7B 模型，int4 量化 ≈ 4GB
```

**KV Cache**：

```
每 token 的 KV 大小 = 2 × layers × hidden_dim × 2 bytes × (K 和 V)
```

**简化公式（可直接用）**：

```
KV Cache 总量 = 2 × num_layers × num_kv_heads × head_dim × 2 × seq_len × concurrent_seqs
```

**举例（Llama-3-8B，bf16）**：

```
layers = 32, kv_heads = 8, head_dim = 128
每 token 每序列 ≈ 2 × 32 × 8 × 128 × 2 = 131072 bytes ≈ 128KB
```

**这意味着**：

```
8192 上下文 × 50 并发 ≈ 128KB × 8192 × 50 ≈ 52GB
→ 24G 显存根本跑不动 50 并发 8K 上下文
```

**"能跑起来"和"能扛并发"是两件事**。

### 为什么批量大了反而慢

**三个原因**：

**① KV Cache 满了 → 排队**

```
max-num-seqs 太大 → KV Cache 被占满 → 新请求要等旧请求结束
→ 表面"并发高"，实际全部在排队，TTFT 暴涨
```

**`--max-num-seqs` 不该设得比"显存能装下的并发"更大**。

**② 注意力计算是 O(n²)**

```
长上下文下，prefill 阶段的计算量随长度平方增长
→ 一个 32K 请求可能顶掉十几个 2K 请求的时间
```

**处理**：

```
① 限制 max-model-len（别一上来就 128K）
② 长请求单独走一个实例（隔离）
③ 用 chunked prefill（把长 prefill 切片）
```

**③ 调度不公平**

```
大请求长期占着 batch → 小请求饿死
```

**vLLM 有 `--scheduling-policy`**（默认 FCFS，可选 priority）。

### 一个"稳妥"的调参路径

```
① 先确定 max-model-len（按业务实际需要，不要贪大）
② 按"显存 = 权重 + 预留" 算剩余给 KV
③ 反推"能支持多少并发 × 多少上下文"
④ 把 max-num-seqs 设成这个并发数
⑤ max-num-batched-tokens 设为 max-num-seqs × 平均上下文（但要小于总量）
⑥ 压测（用 vllm benchmark）验证 TTFT/TPOT/吞吐
```

**压测命令**：

```bash
vllm bench serve \
  --model /models/Qwen2.5-7B-Instruct \
  --dataset-name random \
  --num-prompts 200 \
  --request-rate 10
```

### 量化：省显存但掉精度

```
FP16/BF16 ：原生精度
INT8      ：约省一半，精度损失小
INT4/AWQ  ：省 3/4，精度损失可感知（长上下文更明显）
```

**建议**：

```
① 先用 bf16 建立基线
② 需要更高并发再上 int8
③ int4 只在"显存实在不够"时用
④ 上线前用业务数据集做质量回归
```

**"量化后效果好"和"量化后没变差"是两回事**，要做对比评测。

### 五个上线必然遇到的问题

**① 首请求特别慢（编译/图捕获）**

```
vLLM 启动后会做 CUDA graph 捕获，几十秒到几分钟
→ 健康检查要留足启动宽限期
```

**② OOM 在长上下文时突然发生**

```
原因：KV Cache 估算按"平均长度"，实际有超长请求
处理：max-model-len 明确限制 + 客户端也限制
```

**③ 多卡张量并行的通信开销**

```
TP=2/4 时，每层都要 all-reduce
→ 卡间带宽（NVLink vs PCIe）决定实际收益
```

**PCIe 环境下 TP=4 的收益可能远低于预期**。

**④ 模型加载时间与镜像大小**

```
7B 模型 14GB → 镜像拉取与加载都要几分钟
处理：模型挂载（PVC/对象存储）+ 预热节点
```

**⑤ 客户端超时与流式**

```
LLM 生成可能几十秒 → 客户端/网关超时必须放大
必须用流式（SSE），否则用户等到超时
```

**"网关 60s 超时 + 非流式"是最常见的翻车组合**。

### 部署形态

**单实例（单卡）**：

```yaml
resources:
  limits:
    nvidia.com/gpu: 1
```

**多卡**（同一 Pod 拿多卡，TP 只能在同一 Pod 内）：

```yaml
resources:
  limits:
    nvidia.com/gpu: 2
args: ["--tensor-parallel-size", "2"]
```

**注意**：

```
TP 不能跨 Pod（vLLM 的 TP 是进程内通信）
→ K8s 上必须一个 Pod 拿多卡
```

### 监控看什么

```
① GPU 利用率（是否打满）
② 显存使用（接近上限要警惕）
③ TTFT P99
④ 排队请求数（vllm 暴露的 metrics）
⑤ tokens/s 吞吐
```

**vLLM 自带 Prometheus metrics**（`/metrics` 端点）：

```
vllm:num_requests_running
vllm:num_requests_waiting
vllm:time_to_first_token_seconds
vllm:gpu_cache_usage_perc
```

**`num_requests_waiting` 持续 > 0 说明容量不够**。

### 检查清单

```
□ 按业务定 max-model-len（不贪大）
□ 算过显存（权重 + KV + 开销）
□ max-num-seqs 不超过显存能装的并发
□ 开启 prefix caching（对话场景）
□ 长请求隔离（单独实例或限长）
□ 有压测基线（TTFT/TPOT/吞吐）
□ 量化做过质量回归
□ 启动宽限期足够（CUDA graph 捕获慢）
□ 客户端用流式 + 放大超时
□ TP 在同一 Pod 内
□ 模型走挂载（不进镜像）
□ 监控 waiting 队列与显存
```
