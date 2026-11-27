---
title: 大模型推理服务上线：显存、并发与网关超时
description: vLLM/Triton 这类推理服务上线后最先撞上的四个问题：显存不够、并发上不去、首字节太慢、网关超时。给出量化方法与调参顺序。
date: 2022-03-29
tags: [推理服务, vLLM, GPU, 大模型, 部署]
---

### 和普通 Web 服务的四个不同点

1. **启动慢**：加载权重可能要 1–5 分钟，健康检查不能按秒算。
2. **显存是硬上限**：KV Cache 一满就直接失败，不像内存还能换页。
3. **延迟指标不同**：首 token 延迟（TTFT）和每 token 间隔（ITL）要分开看。
4. **长连接**：流式输出会挂住连接几十秒，网关默认超时全都会踩到。

### 显存怎么估

粗略公式（7B 模型为例）：

```
权重: 7B × 2 bytes(fp16) ≈ 14 GB
KV Cache: 2 × layers × heads × head_dim × seq_len × batch × 2 bytes
开销: 框架与 CUDA context ≈ 2–3 GB
```

实际给 `--gpu-memory-utilization` 留余量（如 0.85），别设 1.0——OOM 常常来自碎片而不是总量。

```bash
nvidia-smi --query-gpu=memory.total,memory.used --format=csv
```

### 起一个 vLLM 服务

```bash
docker run -d --gpus all --name vllm -p 8000:8000 \
  -v /models:/models \
  vllm/vllm-openai:latest \
  --model /models/qwen2-7b-instruct \
  --served-model-name qwen7b \
  --gpu-memory-utilization 0.85 \
  --max-model-len 8192 \
  --max-num-seqs 64
```

```bash
curl -s http://127.0.0.1:8000/v1/models
curl -s http://127.0.0.1:8000/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model":"qwen7b","messages":[{"role":"user","content":"用一句话解释 TCP"}],"max_tokens":64
}'
```

关键参数的作用：

| 参数 | 影响 | 调大/调小 |
| --- | --- | --- |
| `max-model-len` | 上下文长度 | 调大占更多 KV Cache |
| `max-num-seqs` | 并发序列数 | 调大吞吐上升、单请求变慢 |
| `gpu-memory-utilization` | 显存占比 | 与 KV Cache 容量直接相关 |

### 并发上不去：先分清是哪种瓶颈

```bash
# 压测（用 vllm 自带或 wrk/vegeta 做流式请求）
python benchmarks/benchmark_serving.py --backend vllm \
  --model qwen7b --dataset-name sharegpt --num-prompts 200 --request-rate 8
```

三种典型瓶颈：

- **GPU 利用率 100%、队列变长**：算力饱和，加卡或降 batch。
- **GPU 利用率不满、请求排队**：`max-num-seqs` 太小或调度阻塞。
- **显存打满、频繁 preempt**：KV Cache 不足，降 `max-model-len` 或加卡。

看指标：`vllm:num_requests_running`、`vllm:num_requests_waiting`、`vllm:gpu_cache_usage_perc`。等待队列持续 > 0 就是容量不够。

### 网关超时：必须改的三个值

流式输出几十秒很常见，而 nginx 默认 `proxy_read_timeout 60s`，一超时就 504。

```nginx
location /v1/ {
    proxy_pass http://vllm:8000;
    proxy_buffering off;                  # 流式必须关闭缓冲
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
}
```

`proxy_buffering off` 是最容易漏的：开着缓冲，SSE 会被攒着一起发，用户看到的是"卡很久然后一次刷出来"。

同理，Ingress 侧要加注解：

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-buffering: "off"
  nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
```

### 健康检查要单独做

模型加载期间进程活着但不可用。用 readiness 区分：

```yaml
startupProbe:
  httpGet: { path: /health, port: 8000 }
  failureThreshold: 60
  periodSeconds: 10          # 最多等 10 分钟
readinessProbe:
  httpGet: { path: /health, port: 8000 }
  periodSeconds: 15
```

只配 liveness 会在加载期反复重启，永远起不来。

### 该监控的五个指标

1. TTFT P95（首 token 延迟）——用户体验的直接体现。
2. ITL P95（token 间隔）——流式是否顺畅。
3. 请求队列长度——容量是否够。
4. 显存使用率与 KV Cache 占用——OOM 前兆。
5. 每秒 token 吞吐——成本核算的基础。

### 成本与容量的现实

- 单卡 7B fp16 大概能扛 10–20 并发（看上下文长度）。
- 上下文从 4K 涨到 8K，KV Cache 翻倍，并发直接减半。
- 量化（int8/awq）能省显存，但要注意精度损失与吞吐变化，必须实测。

### 上线前的检查表

```
[ ] 模型能加载，startupProbe 时间够
[ ] 网关缓冲关闭、超时调大
[ ] 显存利用率留 15% 余量
[ ] 压测过目标并发，知道拐点在哪
[ ] TTFT/ITL/队列/显存四项有监控与告警
[ ] 有降级方案（小模型或排队提示）
```

推理服务的难点不在"跑起来"，而在**知道它在什么负载下会崩，以及崩之前监控能不能提前叫**。
