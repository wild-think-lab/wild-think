---
title: LogQL：在 Loki 里把日志当数据库查
description: 六个高频查询模式、标签与过滤的区别、性能陷阱，以及五个"查了半天没结果"的原因。
date: 2026-03-25
tags: [可观测, Loki, LogQL]
---

### 两种查询

```
① 日志查询（log query）：返回日志行
② 指标查询（metric query）：对日志聚合，返回数值
```

**"先指标定位时间窗，再日志看细节"** 是效率最高的用法。

### 六个高频写法

**① 按标签选 + 关键字**

```logql
{app="api", env="prod"} |= "error"
```

**② 排除噪音**

```logql
{app="api"} |= "error" != "healthcheck" != "favicon"
```

**③ 正则**

```logql
{app="api"} |~ `status=5\d\d`
```

**④ JSON 解析 + 按字段过滤**

```logql
{app="api"} | json | status >= 500 | level="error"
```

**⑤ 聚合（错误率）**

```logql
sum(rate({app="api"} |= "error" [5m])) by (instance)
```

**⑥ TopN 慢接口**

```logql
topk(5, sum by (path) (count_over_time({app="api"} | json | duration > 500 [5m])))
```

### 标签 vs 过滤：性能分界线

```
标签（{} 里的）：索引，查询快，但基数必须低
过滤（|= 里的）：全文扫描，慢，但可以任意
```

**"把 request_id 放标签"** → 索引爆炸（Loki 会拒绝或变极慢）。

**正确**：

```
标签：app / env / host / level（低基数）
过滤：trace_id / user_id / 具体内容
```

### 常用函数

```
rate()            ：每秒速率
count_over_time() ：时间窗内计数
sum by (x)        ：按 x 聚合
topk(n, ...)      ：前 n
bytes_rate()      ：日志体积速率（用于成本分析）
```

### 五个"查了半天没结果"

**① 标签值不对**

```logql
{app="api"}      # 实际标签是 app_name="api"
```

**先看有哪些标签**：

```logql
{app="api"} | label_format ...   # 或直接查一个宽范围再看字段
```

**② 时间范围没覆盖**

```
日志在 03:00 发生，查询窗口是 10:00 → 当然没有
```

**③ 大小写/字段名**

```
json 解析后字段是 "Status" 而不是 "status"（大小写敏感）
```

**④ 日志根本没被采集**

```
先查"这个 app 有任何日志吗"：count_over_time({app="api"}[1h])
```

**"0 条"** → 采集问题，不是查询问题。

**⑤ 过滤条件互相排斥**

```logql
|= "error" != "error"    # 永远为空
```

### 一个"排障"的实际用法

```
1) 指标：sum(rate({app="api"} |= "error" [1m])) → 找尖峰时段
2) 日志：{app="api"} |= "error" 且时间窗 = 尖峰
3) 细化：| json | status >= 500 | line_format "{{.path}} {{.msg}}"
4) 找 trace_id：从日志里取 → 跳链路系统
```

**"指标找窗、日志找因"** 比"直接翻日志"快十倍。

### 成本与保留

```
① 日志体积 = 行数 × 平均长度
② 用 bytes_rate 看"哪个服务日志最多"
③ 高体积服务做采样/减少 debug
④ 保留期分级（热 7 天 / 冷 30 天）
```

**"debug 级别全量采集"** 是成本黑洞。

### 检查清单

```
□ 标签低基数（app/env/host）
□ trace_id 放内容不放标签
□ 会用 json 解析按字段过滤
□ 会用 count_over_time 确认"有没有日志"
□ 会用 rate 找错误尖峰
□ 会用 topk 找最热路径
□ 查询有明确时间窗
□ 关注 bytes_rate（成本）
□ 有分级保留策略
□ 日志里带 trace_id（能跳链路）
```
