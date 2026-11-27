---
title: 日志采集：从应用日志到可查询
module: 熟练篇
summary: 结构化日志、采集链路（文件 → 采集器 → 存储）、多行日志与字段约定，五个"日志有了却查不到"的原因。
minutes: 45
---

### 先决定日志格式

```
① 结构化（JSON）：一条日志一个 JSON 行
② 字段固定：ts / level / service / trace_id / msg
③ 异常堆栈放一个字段（多行合并）
```

**"日志是给人看的散文"** → 机器无法聚合与告警。

### 采集链路

```
应用 → stdout/文件 → 采集器（Filebeat/Vector/Promtail）
     → 缓冲 → 存储（Loki / ES / ClickHouse）→ 查询 UI
```

**关键**：采集器要能"记住读到哪了"（position 文件），否则重启丢一段。

### 结构化示例

```json
{"ts":"2026-11-27T10:00:01Z","level":"error","service":"order",
 "trace_id":"a1b2","msg":"create order failed","err":"timeout","ms":1203}
```

```python
# Python 侧
import json, logging
class JsonFormatter(logging.Formatter):
    def format(self, r):
        return json.dumps({"ts": self.formatTime(r), "level": r.levelname,
                           "service": "order", "msg": r.getMessage()},
                          ensure_ascii=False)
```

### 多行日志（Java 堆栈）

```
不合并 → 一个异常变成 30 条"孤立"日志，查不到根因
```

```yaml
# Filebeat
multiline:
  pattern: '^\s+(at |Caused by)'
  negate: true
  match: after
```

**新方案**：应用直接输出 JSON（堆栈一个字段），比正则更可靠。

### 字段约定（跨服务统一）

```yaml
必需：ts, level, service, msg
强烈建议：trace_id, request_id, user_id(脱敏), http_status, duration_ms
禁止：把整个请求体/密码打进日志
```

**"每个服务字段名不同"** → 无法跨服务串联一次请求。

### 采样与成本

```
① 高频正常日志：采样（如 1/10）
② 错误日志：全量
③ 保留期：热 7 天 / 温 30 天 / 冷 半年
```

**"所有日志永久保留"** → 存储成本失控。

### 五个"日志有了却查不到"

**① 时区错位**

```
应用写 UTC、查询按本地时间 → 差 8 小时
```

**② trace_id 没透传**

```
网关生成了，但没往下游传 → 串不起来
```

**③ 多行被拆**

```
一条异常几十条，关键词命中率低
```

**④ 采集器丢尾**

```
进程被杀未 flush / position 文件损坏
```

**⑤ 字段类型不一致**

```
status 有时字符串有时数字 → 聚合出错
```

### 检查清单

```
□ 日志是结构化（JSON）
□ 字段命名跨服务统一
□ 有 trace_id 且全链路透传
□ 多行合并（或直接 JSON）
□ 采集器有缓冲与 position
□ 有保留期与采样策略
□ 敏感字段脱敏
□ 有"错误日志突增"告警
□ 时区统一（建议 UTC 存储）
□ 有日志量监控（防爆量）
```
