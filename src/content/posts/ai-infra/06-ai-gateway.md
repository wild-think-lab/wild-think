---
title: AI 网关：把模型调用收成一条可控的入口
description: 为什么需要一个 AI 网关、多模型路由与降级、Token 配额与限流、缓存与语义缓存、日志与成本归因，附最小实现思路。
date: 2026-11-27
tags: [AI网关, 大模型, 限流, 成本, 架构]
---

### 业务直接调模型 SDK 会出什么问题

一开始都是这样：

```python
client.chat.completions.create(model="gpt-4o", messages=...)
```

三个模型、五个业务线之后，问题集中爆发：

1. **成本不可见**：月底账单才知道某个功能花了 80% 的钱。
2. **没有配额**：一个爬虫业务把额度用光，全公司不可用。
3. **切换模型要改代码**：供应商涨价/限流，改 20 个仓库。
4. **没有降级**：主模型 429，业务直接报错。
5. **审计缺失**：谁把用户数据发给了第三方模型，说不清。

AI 网关就是把这些收成一层。

### 网关该做的六件事

```
① 统一协议（对外一种接口，对内适配多家）
② 路由与降级（按任务/成本/质量选模型）
③ 配额与限流（按租户/业务/用户）
④ 缓存（精确缓存 + 语义缓存）
⑤ 可观测（延迟、token、成本、错误率）
⑥ 安全（PII 脱敏、审计日志）
```

不需要它做的：提示词编排（那是业务）、模型训练、向量检索。

### 统一协议

对外维持 OpenAI 兼容格式最省事，客户端 SDK 不用改：

```http
POST /v1/chat/completions
Authorization: Bearer <业务自己的 key>
X-Tenant-Id: order-team
```

网关内部再翻译成各家风格（Anthropic messages、Gemini contents、国内厂商的格式）。

### 路由与降级的三种策略

**按任务类型路由**：

```yaml
routes:
- match: { task: "summarize" }
  primary: cheap-model-a
  fallback: [cheap-model-b]
- match: { task: "code-review" }
  primary: strong-model
  fallback: [strong-model-alt]
```

**按预算路由**：额度剩 80% 用强模型，剩 20% 降级到便宜模型。

**按健康路由**：主模型 429/5xx 超过阈值，30 秒内自动切备用，恢复后探活再切回。

```python
def pick(route):
    if breaker.open(route.primary):
        return route.fallback[0]
    return route.primary
```

熔断器是必须的：**上游限流时，无脑重试只会把额度烧得更快**。

### 配额与限流：三个维度

| 维度 | 例子 | 实现 |
| --- | --- | --- |
| 租户/业务 | 订单团队每小时 200 万 token | Redis 计数器 + 窗口 |
| 用户 | 单用户每分钟 20 次 | 令牌桶 |
| 全局 | 全站每分钟 500 万 token | 网关层滑动窗口 |

按 **token** 限流比按"请求数"更合理：一次请求可能 50 token，也可能 5000 token。

```lua
-- Redis 令牌桶（简化）
local key = KEYS[1]
local rate, burst, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local tokens = tonumber(redis.call('GET', key) or burst)
local last = tonumber(redis.call('GET', key .. ':ts') or now)
tokens = math.min(burst, tokens + (now - last) * rate)
if tokens < 1 then return 0 end
redis.call('SET', key, tokens - 1)
redis.call('SET', key .. ':ts', now)
return 1
```

### 缓存：精确 + 语义

**精确缓存**：`hash(model + messages + temperature + max_tokens)` 做 key。相同请求直接返回，命中率在"FAQ/文档问答"场景能到 30–50%。

**语义缓存**：把问题向量化，相似度 > 0.92 就复用答案。命中率更高，但有"答非所问"的风险，**必须加人工抽检或降级策略**。

两个坑：

1. 缓存里存了含用户隐私的回答 → 泄露给别人。key 里必须带 `tenant_id`，且敏感业务禁用缓存。
2. 温度 > 0 的请求缓存意义有限（本来就要多样性）。

### 可观测：四个必采指标

```promql
# 1. 每租户 token 消耗
sum by (tenant) (rate(llm_tokens_total[1h]))
# 2. 成本（按模型单价换算）
sum by (model) (rate(llm_tokens_total[1h] * on(model) group_left llm_price_per_token))
# 3. 首 token 延迟 P95
histogram_quantile(0.95, sum by (le, model) (rate(llm_ttft_seconds_bucket[5m])))
# 4. 错误率（含 429）
sum(rate(llm_requests_total{status=~"429|5.."}[5m])) / sum(rate(llm_requests_total[5m]))
```

日志里必须记：`tenant`、`model`、`prompt_tokens`、`completion_tokens`、`latency`、`trace_id`、`cache_hit`。

有了这些，成本归因才能做到"这个功能每月花多少钱、哪个团队在涨"。

### 安全：三件必做

1. **PII 脱敏**：手机号、身份证、邮箱在出网关前替换成占位符，返回时再还原。
2. **提示注入防护**：对"用户输入拼接进系统提示"的场景做检测与隔离。
3. **审计**：记录"谁在什么时候把什么类型的请求发给了哪个供应商"，保留 6 个月。

```python
PATTERNS = {
    "phone": r"1[3-9]\d{9}",
    "idcard": r"\d{17}[\dXx]",
}
```

### 最小实现路径

不想上商业网关，可以先用一层简单服务顶上：

```
Nginx（鉴权 + 粗限流）
   ↓
自研 gateway（Go/Python，200–500 行）
   ├─ 路由表（YAML）
   ├─ Redis 配额
   ├─ 精确缓存
   └─ 日志 → ClickHouse/PG
```

关键是把"调用"收成一处，后面加能力（语义缓存、成本看板、灰度）才有地方加。

成熟方案可选：LiteLLM Proxy、Higress AI 网关、Kong AI Gateway、OneAPI。它们已覆盖协议适配与配额，自研的收益主要在"深度定制计费与路由"。

### 一句话总结

AI 网关的价值不在"转发请求"，而在**让 Token 变成可计量、可限额、可归因、可降级的资源**。
