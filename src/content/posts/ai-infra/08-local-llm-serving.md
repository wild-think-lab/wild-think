---
title: 本地跑大模型：Ollama 与 vLLM 的分工
description: 两者的定位差异、显存怎么估、量化格式的选择、并发与吞吐的真实数据，以及"为什么我的 4090 跑不动 70B"。
date: 2023-07-13
tags: [AI, 推理, Ollama, vLLM, GPU]
---

### 定位差异

| | Ollama | vLLM |
| --- | --- | --- |
| 目标 | 个人使用、快速上手 | 服务化、高吞吐 |
| 并发 | 弱（单请求为主） | 强（连续批处理） |
| 模型格式 | GGUF（量化友好） | safetensors（原始精度） |
| 硬件 | CPU/GPU 都行 | 主要 GPU |
| 部署 | 一条命令 | 需要写服务、配参数 |

**一句话**：自己试模型用 Ollama，要对外提供服务用 vLLM。

### 显存怎么估

粗略公式（FP16）：

```
显存 ≈ 参数量 × 2 字节 × 1.2（KV Cache 与开销）
7B   ≈ 14G × 1.2 ≈ 17G
13B  ≈ 26G × 1.2 ≈ 31G
70B  ≈ 140G × 1.2 ≈ 168G
```

量化后：

| 量化 | 每参数比特 | 7B 占用 |
| --- | --- | --- |
| FP16 | 16 | ~17G |
| Q8 | 8 | ~9G |
| Q4 | 4 | ~5G |

**Q4 是质量/体积的常用平衡点**，再往下（Q3/Q2）质量下降明显。

### "为什么 4090 跑不动 70B"

4090 有 24G 显存，70B 即使 Q4 也要 ~40G。三个办法：

1. **多卡**（2×4090 = 48G，勉强 Q4，但 PCIe 带宽是瓶颈）。
2. **CPU offload**（把部分层放内存，速度大幅下降，可能只有 1–3 token/s）。
3. **用小模型**（Qwen2.5-14B、Llama3-8B 在单卡上体验更好）。

**经验值**：

```
单卡 24G：
  7B Q4   → 流畅（30+ token/s）
  13B Q4  → 可用（15–25 token/s）
  32B Q4  → 勉强（5–10 token/s）
  70B     → 不可用
```

### Ollama 上手

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:7b
ollama run qwen2.5:7b

# API
curl http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:7b",
  "prompt": "用三句话解释什么是 TCP 三次握手",
  "stream": false
}'
```

GPU 是否生效：

```bash
ollama ps
# NAME          SIZE    PROCESSOR   UNTIL
# qwen2.5:7b    5.4 GB  100% GPU    4 minutes from now
```

如果显示 `100% CPU` → 驱动或 CUDA 没装好。

### vLLM 服务化

```bash
pip install vllm
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct \
  --tensor-parallel-size 1 \
  --gpu-memory-utilization 0.9 \
  --max-model-len 8192 \
  --port 8000
```

它提供 OpenAI 兼容接口，客户端不用改代码：

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8000/v1", api_key="none")
client.chat.completions.create(
    model="Qwen/Qwen2.5-7B-Instruct",
    messages=[{"role": "user", "content": "你好"}]
)
```

### 关键参数

| 参数 | 作用 | 建议 |
| --- | --- | --- |
| `--tensor-parallel-size` | 张量并行卡数 | = GPU 数量 |
| `--gpu-memory-utilization` | 显存占用上限 | 0.85–0.9（留余量） |
| `--max-model-len` | 最大上下文 | 按需，越大越占显存 |
| `--max-num-seqs` | 最大并发请求 | 按显存调 |
| `--quantization` | 量化 | awq/gptq/fp8 |

**`--max-model-len` 是最容易被忽略的显存杀手**：设成 32k 时 KV Cache 可能占掉一半显存。

### 吞吐实测（7B，单卡 4090）

| 场景 | 吞吐 |
| --- | --- |
| Ollama 单请求 | ~35 token/s |
| vLLM 单请求 | ~40 token/s |
| vLLM 并发 8 | ~180 token/s（总） |
| vLLM 并发 32 | ~260 token/s（总，延迟上升） |

结论：**并发场景 vLLM 的总吞吐是 Ollama 的 5–8 倍**，因为连续批处理（continuous batching）。

### 常见问题

**① 显存不足（OOM）**

```
报错：CUDA out of memory
解法：降 --gpu-memory-utilization、降 --max-model-len、换更小量化
```

**② 首次加载很慢**

模型要从磁盘读进显存（7B 约 15G，机械盘要几十秒）。用 NVMe。

**③ 输出乱码/重复**

- 量化太狠（Q2/Q3）。
- 缺 chat template（没按模型要求拼 prompt）。

```bash
# vLLM 指定 chat template
--chat-template ./template.jinja
```

**④ 中文效果差**

选对模型：Qwen 系列对中文较好。Llama 原生中文弱，需要中文微调版。

### 该选哪个（决策表）

| 需求 | 选 |
| --- | --- |
| 本地试模型、写代码辅助 | Ollama |
| 给团队提供统一 API | vLLM |
| 只有 CPU | Ollama（llama.cpp 后端） |
| 需要高并发（> 10） | vLLM |
| 要多卡大模型 | vLLM（TP/PP） |

### 检查清单

```
□ 显存估算过（参数量 × 2 × 1.2，量化后再除）
□ 单卡 24G 不要碰 70B
□ Ollama 确认 `ollama ps` 显示 GPU
□ vLLM 的 max-model-len 按需设置
□ 有并发压测数据（不是"感觉挺快"）
□ 模型文件放 NVMe
```
