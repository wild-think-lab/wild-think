---
title: 第 3 章 · 日志：结构化、采集与查询
module: 入门篇
summary: 为什么"打印字符串"会毁掉排障效率、JSON 日志的六个必备字段、采集链路与限速、以及日志查询的三种正确姿势。
minutes: 20
---

### 日志的第一原则：能机器解析

```log
2026-11-27 10:12:33 ERROR order service failed, userId=123, err=timeout
```

人看得懂，机器要写正则才能解析。改一个字段顺序就全断。

正确形态：

```json
{"ts":"2026-11-27T10:12:33Z","level":"error","service":"order","traceId":"2f8a","userId":"123","msg":"create order failed","err":"context deadline exceeded","latency_ms":3001}
```

好处：可精确过滤、可聚合统计、字段顺序无关、跨服务统一。

### 六个必备字段

| 字段 | 为什么必须有 |
| --- | --- |
| `ts` | 时间戳，ISO8601 + 时区 |
| `level` | 分级，用于过滤与统计 |
| `service` | 哪个服务产生的 |
| `traceId` | 串起一次请求的全链路 |
| `msg` | 人能读的一句话 |
| `err` | 错误详情（含原因链，不只是"失败了"） |

可选但很有价值：`userId`、`path`、`status`、`latency_ms`、`host`、`version`。

### 分级要真的分级

```
DEBUG  排障细节，生产默认关
INFO   正常事件（请求进来、任务完成），量大
WARN   可恢复的异常（重试成功、降级生效）
ERROR  需要人关注的失败
FATAL  进程级故障
```

三条纪律：

1. **ERROR 必须"需要人看"**。把可恢复的重试记成 ERROR，等于制造噪音。
2. **INFO 要控制量**。每个请求打 5 行 INFO，高峰期日志量会压垮采集。
3. **不要打敏感信息**。手机号、身份证、密码、完整 token——在写日志那一刻就要脱敏。

```python
def mask(phone: str) -> str:
    return phone[:3] + "****" + phone[-4:]
```

### 采集链路

```
应用 stdout/stderr → 容器运行时 → 节点文件 → agent → 传输 → 存储
                                                       ↘ 直连（小规模）
```

小规模（<20 节点）：

```
Fluent Bit 直接写 Loki / ES
```

中等规模：

```
Fluent Bit → Kafka（缓冲） → 消费者 → Loki/ES
```

Kafka 缓冲的价值：**日志暴涨时不丢数据，也不打爆存储**。没有缓冲时，一次误开的 DEBUG 能把存储写满。

### 采集侧四个必配

```toml
[INPUT]
    Name    tail
    Path    /var/log/app/*.log
    Parser  json
    Mem_Buf_Limit 64MB        # 内存缓冲上限，防 OOM
    Skip_Long_Lines On
    DB      /var/lib/flb/pos.db   # 记录读取位置，重启不重读

[FILTER]
    Name   modify
    Match  app.*
    Add    env prod

[OUTPUT]
    Name   loki
    Match  app.*
    Host   loki.internal
    Labels service, env, level
```

1. **`DB` 记录位置**：否则 agent 重启会把所有日志重读一遍。
2. **内存/磁盘缓冲上限**：下游挂了不至于把节点写满。
3. **多行合并**：堆栈要合成一条，否则无法阅读。
4. **标签选低基数**：`service`、`env`、`level` 可以；`traceId` 不行。

### 查询的三种姿势

**① 按服务 + 时间 + 级别**

```logql
{service="order", level="error"} | json
```

**② 按 traceId 追一次请求**

```logql
{env="prod"} |= "traceId=2f8a91c"
```

这是最有价值的一种。前提是 traceId 在所有服务都记录了。

**③ 按内容过滤**

```logql
{service="order"} |= "deadline exceeded" != "retry succeeded"
```

`|=` 包含，`!=` 排除。排除比包含更能降低噪音。

### 日志量控制

| 手段 | 效果 |
| --- | --- |
| 关掉生产 DEBUG | 通常降 50–80% |
| 采样访问日志（如 1/10） | 线性下降 |
| 只对错误请求打详细日志 | 保留排障能力 |
| 结构化字段替代长文本 | 体积↓、可查询↑ |

估算：每行 500 字节，QPS 1000，一天 = 43GB。**这个量级下不控制就等于每天写满一块盘**。

### 三个常见误区

**① 日志当数据库用**

把每笔订单的完整 JSON 打进日志，然后想用它做统计。日志不是 OLAP，量一大查询就崩。统计应该走指标或专门的数仓。

**② 无 traceId**

跨服务排障时只能靠时间戳猜，几万条日志里找一条，等于大海捞针。

**③ 只保留 3 天**

故障从发生到被发现平均要几小时到几天。保留期太短，复盘时数据已经没了。至少 7 天，重要业务 30 天。

### 这一章的验收

```
□ 应用日志是 JSON，含六个必备字段
□ ERROR 级别只在"需要人看"时打
□ 采集 agent 有位置记录与缓冲上限
□ 能用 traceId 从网关一路查到下游
□ 知道每天日志量是多少 GB
```

### 练习

1. 把一个还在打纯文本日志的服务改成 JSON 结构化日志。
2. 造一条跨两个服务的请求，用同一个 traceId 在两边日志里找到它。
3. 估算你现在的日志日增量，并说明保留 30 天需要多少存储。
