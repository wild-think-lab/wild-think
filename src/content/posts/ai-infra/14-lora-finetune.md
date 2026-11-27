---
title: 模型微调入门：LoRA 到底在改什么
description: 全参微调与 LoRA 的差别、显存估算、数据准备的三条原则，以及五个"微调完效果更差"的原因。
date: 2024-12-21
tags: [AI, 微调, LoRA]
---

### 先分清三种"让模型适配业务"的方式

```
① Prompt（提示词）：不改权重，最便宜
② RAG（检索增强）：外挂知识，适合"事实类"
③ 微调（Fine-tune）：改权重，适合"风格/格式/任务能力"
```

**"知识更新"优先 RAG，"行为改变"才考虑微调**。

### 全参 vs LoRA

| 维度 | 全参微调 | LoRA |
| --- | --- | --- |
| 可训练参数 | 100% | 0.1%–2% |
| 显存 | 极高（7B 需多卡） | 低（单卡可跑） |
| 效果 | 上限最高 | 接近（多数场景） |
| 多任务 | 一个任务一份权重 | 一个底座多个 adapter |
| 部署 | 换整个模型 | 动态加载 adapter |

**"资源有限 + 单任务" → LoRA 是默认答案**。

### LoRA 在改什么

```
原权重 W（冻结不动）
新增两个小矩阵 A（d×r）与 B（r×d）
输出 = W + B·A（r 很小，如 8/16/32）
```

**"只训练低秩增量"** —— 这就是 LoRA 的全部。

**关键参数**：

```
r（rank）      ：8/16/32，越大容量越强但越容易过拟合
alpha          ：通常 2×r，控制缩放
target_modules ：哪些层加 adapter（q/k/v/o + mlp 通常都加）
```

**"target_modules 只加 q/v"** 效果通常不如"全线性层"。

### 显存估算（粗略）

```
7B 模型 LoRA（bf16）：
  底座权重       ≈ 14GB
  梯度 + 优化器  ≈ 少量（只对 adapter）
  激活值         ≈ 视 batch/seq_len
  → 24GB 单卡可跑（batch=1, seq=512）
```

**13B 需要 40GB+ 或量化底座**（QLoRA 用 4bit 底座把门槛压到 16GB）。

**QLoRA**：

```
4bit 量化底座 + LoRA adapter
→ 效果略降，但门槛大幅下降
```

### 数据准备的三条原则

**① 质量 > 数量**

```
100 条高质量样本 > 10000 条噪音
```

**② 格式与推理一致**

```
训练时用 "用户: xxx\n助手: yyy"
推理时提示词必须同结构
→ 否则"训练集上很好，上线就崩"
```

**③ 覆盖"边界与拒答"**

```
只教"正常回答" → 模型在边界场景胡编
→ 要包含"不知道就说不确定"的样本
```

### 一个最小可跑的例子

```python
from datasets import load_dataset
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer

base = "Qwen/Qwen2.5-7B-Instruct"
tok = AutoTokenizer.from_pretrained(base)
model = AutoModelForCausalLM.from_pretrained(base, torch_dtype="bfloat16", device_map="auto")

cfg = LoraConfig(
    r=16, lora_alpha=32, lora_dropout=0.05,
    target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
    task_type="CAUSAL_LM",
)
model = get_peft_model(model, cfg)

args = TrainingArguments(
    output_dir="out", num_train_epochs=3,
    per_device_train_batch_size=1, gradient_accumulation_steps=8,
    learning_rate=2e-4, bf16=True, logging_steps=10,
    save_strategy="epoch",
)
Trainer(model=model, args=args, train_dataset=ds, tokenizer=tok).train()
model.save_pretrained("lora-out")
```

**学习率 2e-4 是 LoRA 的常见起点**（比全参大一个数量级）。

### 五个"微调完效果更差"的原因

**① 数据格式与推理不一致**

```
训练用 "### 问题" 模板，推理用另一种
→ 模型认不出"该开始回答了"
```

**② 学习率太高 / epoch 太多**

```
3 个 epoch 后开始"灾难性遗忘"（通用能力下降）
→ 用 eval 集监控"通用能力是否退化"
```

**③ 数据里有"矛盾样本"**

```
同一个问题两种答案 → 模型学成"随机"
```

**④ 只测"训练集相似样本"**

```
训练分布内很好，分布外全崩
→ 必须留"分布外"测试集
```

**⑤ 拿微调当"知识注入"**

```
想让模型"记住公司制度" → 微调很难记住细节
→ 这类需求应该用 RAG
```

### 评估怎么做

```
① 任务指标（格式正确率/准确率/拒答率）
② 通用能力回归（用一小套通用题对比前后）
③ 人工抽检（20–50 条，看"像不像人话"）
④ 线上 A/B（如果有条件）
```

**"只看训练 loss 下降"是最常见的误判**。

### 检查清单

```
□ 先判断是否真需要微调（Prompt/RAG 试过）
□ 数据质量优先（清洗 + 去重）
□ 训练格式 = 推理格式
□ 有边界/拒答样本
□ r/alpha 与 target_modules 合理
□ 有 eval 集（含分布外）
□ 监控通用能力是否退化
□ 学习率与 epoch 不要过量
□ 保存 adapter + 训练配置（可复现）
□ 部署时确认"adapter 与底座版本匹配"
```
