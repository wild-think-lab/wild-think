---
title: 日志采集：Fluent Bit / Vector 怎么配才不丢不乱
description: 采集链路四段、解析与路由的写法、背压与磁盘缓冲，以及五个"日志丢了找不到原因"的问题。
date: 2026-11-27
tags: [可观测, 日志, Fluent Bit]
---

### 一条采集链路的四段

```
① 采集（tail 文件 / journald / 容器 stdout）
② 解析（正则/JSON 提取字段）
③ 处理（脱敏/过滤/加标签）
④ 输出（Loki/ES/Kafka/S3）
```

**"每段都要能承受下游变慢"** —— 否则就是丢日志。

### Fluent Bit 最小配置

```ini
[SERVICE]
    Flush 5
    Log_Level info
    storage.path /var/lib/fluent-bit

[INPUT]
    Name tail
    Path /var/log/app/*.log
    Parser json
    Tag app.*
    Mem_Buf_Limit 50MB
    Skip_Long_Lines On

[FILTER]
    Name record_modifier
    Match app.*
    Record host ${HOSTNAME}
    Record env prod

[OUTPUT]
    Name loki
    Match app.*
    Host loki.example.com
    Port 3100
    Labels job=app,host=$host
```

**要点**：

```
① Mem_Buf_Limit 必须有（否则内存打爆）
② storage.path 开启磁盘缓冲（下游恢复后补发）
③ Labels 别放高基数字段（会炸 Loki）
```

### Vector 的配置（TOML）

```toml
[sources.app_logs]
type = "file"
include = ["/var/log/app/*.log"]

[transforms.parse]
type = "remap"
inputs = ["app_logs"]
source = '''
. = parse_json!(.message)
.level = downcase(.level)
'''

[transforms.redact]
type = "remap"
inputs = ["parse"]
source = '''
.detail = redact(.detail, filters: ["pattern"], pattern: "password")
'''

[sinks.loki]
type = "loki"
inputs = ["redact"]
endpoint = "http://loki:3100"
encoding.codec = "json"
labels.job = "app"
```

**Vector 的优势**：

```
① 单二进制（Rust），资源占用低
② remap 的 VRL 语言表达力强
③ 内置"缓冲与背压"控制好
```

**"需要复杂解析/转换"优先 Vector，"轻量边缘采集"用 Fluent Bit**。

### 背压与缓冲（丢日志的真正原因）

```
链路：采集 → 内存缓冲 → 输出
下游慢 → 内存满 → 开始丢
```

**正确配置**：

```
① 内存缓冲上限（Mem_Buf_Limit / buffer.max_events）
② 磁盘缓冲（storage.path / buffer type=disk）
③ 丢弃策略要明确（丢最旧还是拒绝新？）
```

**"不配磁盘缓冲"意味着"下游一抖就丢日志"**。

### 五个"日志丢了找不到原因"

**① 采集器被 OOM Kill**

```
无内存上限 → 峰值时被杀 → 那段日志全丢
```

**② 文件被轮转（rotate）**

```
tail 追踪 inode，轮转后新文件可能没跟上
→ Fluent Bit 用 `Path_Key` + 支持 inode 追踪
→ 或改用 journald/stdout 采集
```

**③ 多行日志被拆成多条**

```
Java 堆栈每行一条 → 完全无法阅读
→ 用 multiline parser（按"时间戳开头"聚合）
```

**④ 高基数字段进标签**

```
Labels 里放 request_id/user_id → Loki 索引爆炸 → 拒绝写入
→ 高基数放"日志内容"，标签只放低基数（job/host/env）
```

**⑤ 时间戳解析错**

```
日志里的时间是本地时区 → 与采集时间差 8 小时
→ 解析时明确时区，或统一用 UTC
```

### 一个"多行 Java 日志"的配置

```ini
[PARSER]
    Name java_multiline
    Type multiline
    Format regex
    Regex /^(?<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})
    Time_Key time
    Time_Format %Y-%m-%d %H:%M:%S
```

**"以时间戳开头"作为一条日志的起点** —— 这个规则最通用。

### 脱敏（合规必做）

```
① 密码/token/身份证/手机号
② 在采集端做（不要指望查询端）
③ 脱敏规则要能"加规则不改管道"
```

```ini
[FILTER]
    Name modify
    Match app.*
    Rename password passwd_redacted
```

**"采集端脱敏"才能保证"存储里没有明文"**。

### 成本控制

```
① 采样（debug 级别不全量）
② 分级存储（热 7 天、温 30 天、冷 6 个月）
③ 压缩（gzip/zstd）
④ 只保留必要字段（不要整个 body）
```

**"debug 日志全量进 ES"是最常见的成本黑洞**。

### 检查清单

```
□ 采集器有内存上限
□ 有磁盘缓冲（下游抖动不丢）
□ 多行日志有聚合规则
□ 轮转/新文件能跟上
□ 时间戳时区正确
□ 标签低基数（不塞 request_id）
□ 采集端脱敏
□ 下游有容量与限流
□ 采集器本身有监控（是否在跑/是否丢）
□ 有分级存储与保留期
```
