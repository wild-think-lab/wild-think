---
title: 日志平台：ELK、Loki、ClickHouse 三条路怎么选
description: 采集、存储、查询三段拆分，成本对比，以及"日志很多但查不到"的五个原因。
date: 2026-04-07
tags: [日志, ELK, Loki, 可观测]
---

### 三段拆分（这是看清所有方案的框架）

```
① 采集（Agent）：Filebeat / Vector / Promtail / Fluent Bit
② 存储与索引：Elasticsearch / Loki / ClickHouse
③ 查询与展示：Kibana / Grafana / 自建
```

**选型其实是在选"存储与索引"那一层**。

### 三条路的本质差别

| 维度 | ELK（ES） | Loki | ClickHouse |
| --- | --- | --- | --- |
| 索引方式 | 全文倒排索引 | 只索引标签（labels） | 列存 + 排序键 |
| 查询能力 | 全文检索最强 | 按标签筛选 + grep | 结构化聚合最强 |
| 存储成本 | 高（索引膨胀） | 低（压缩后接近原日志） | 中（列存压缩好） |
| 写入成本 | 高（分词与索引） | 低 | 中 |
| 上手难度 | 中 | 低 | 中（要懂 SQL） |
| 适合 | 需要"任意关键字搜" | 按服务/实例定位 + 少量 grep | 统计分析与大报表 |

**一句话**：

```
"我要搜任意关键词、还要能聚合分析" → ELK
"我要按服务/实例快速看日志，成本敏感" → Loki
"我要对日志做大量统计" → ClickHouse
```

### 采集端的选择

```
Filebeat  ：轻量、生态好（ELK 官方）
Vector    ：性能强、转换能力强（Rust）
Fluent Bit：极轻量、K8s 友好
Promtail  ：Loki 官方，标签处理方便
```

**K8s 场景推荐**：

```
DaemonSet 采集 /var/log/pods（或用 Loki 的 promtail）
应用最好直接写 stdout（结构化 JSON）
```

**"应用自己写文件再采集"是反模式**：

```
容器里文件会随 Pod 删除 → 丢日志
```

### 标签设计（Loki 最关键的一点）

```yaml
# promtail
scrape_configs:
- job_name: k8s-pods
  kubernetes_sd_configs:
  - role: pod
  relabel_configs:
  - source_labels: [__meta_kubernetes_pod_label_app]
    target_label: app
  - source_labels: [__meta_kubernetes_namespace]
    target_label: namespace
```

**标签设计的铁律**：

```
标签 = 低基数、高价值（app / namespace / env / level）
不要用高基数字段做标签（request_id / user_id / ip）
```

**为什么**：

```
Loki 把标签组合建立"流"（stream）
标签组合爆炸 → 流数爆炸 → 内存与查询都崩
```

**"把 user_id 当标签"是最常见的自毁操作**。

**高基数字段怎么处理**：

```
放进日志内容（用 grep 搜），或放到结构化字段里用过滤
```

### 五个"日志很多但查不到"的原因

**① 时间没对齐**

```
采集端时区与查询端不一致 → 查 10:00 的日志，采到的是 18:00
```

检查：日志里是否有 `timezone` 字段，采集端是否做了 `timestamp` 解析。

**② 多行日志被拆成多行**

```
Java 的堆栈一行一条 → 无法看完整异常
```

处理：配置多行合并。

```yaml
# Filebeat
multiline:
  pattern: '^[0-9]{4}-'
  negate: true
  match: after
```

```yaml
# promtail
pipeline_stages:
- multiline:
    firstline: '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
    max_wait_time: 3s
```

**③ 没有结构化**

```
日志是 "用户 xxx 下单失败 error code 500"
→ 无法按 code 过滤、无法聚合
```

处理：输出 JSON（`{"level":"error","code":500,"uid":"x"}`）。

**④ 索引字段选错**

```
ES 把大文本字段设成 text（分词）→ 存储与查询都慢
应该：只对需要搜索的设 text，其余 keyword
```

```json
{
  "mappings": {
    "properties": {
      "msg":     { "type": "text" },
      "service": { "type": "keyword" },
      "trace_id":{ "type": "keyword" }
    }
  }
}
```

**⑤ 保留期太短**

```
只留 3 天 → 出事时发现"日志已经滚掉了"
```

处理：分层保留（热 7 天 + 冷 90 天，冷数据压低成本）。

### 成本控制（这是最容易失控的地方）

**ES 的成本结构**：

```
① 索引存储（通常是原始日志的 1.5–3 倍）
② 副本（默认 1 副本 = 双倍）
③ 节点资源（JVM + page cache）
```

**低成本做法**：

```
① 热数据（7 天）用 ES，冷数据转对象存储（可查但要等）
② 只对关键字段建索引（日志正文用 keyword + wildcard）
③ 降低副本（非关键日志用 0 副本）
④ 用 ILM 自动滚动 + 删除
```

**Loki 的成本结构**：

```
只有标签索引（很小）+ 压缩后的日志块（对象存储）
→ 成本通常比 ES 低一个数量级
```

**代价**：查询只能"全量扫时间范围 + grep"，复杂分析弱。

### 一条"够用"的日志规范

```json
{
  "ts": "2026-11-27T10:00:00.123Z",
  "level": "error",
  "service": "order-api",
  "env": "prod",
  "trace_id": "abc123",
  "msg": "payment failed",
  "code": 5001,
  "uid": "u_123",
  "duration_ms": 320
}
```

**字段说明**：

```
ts        ：ISO8601 + UTC（必须有）
level     ：统一（debug/info/warn/error）
service   ：服务名（与部署一致）
trace_id  ：贯穿一次请求
msg       ：简短描述（不要拼接大量变量）
其余      ：结构化字段
```

**"msg 里拼接变量"是反模式**：

```
"用户 123 在 10:00 下单商品 456 失败"
→ 无法按 uid 过滤，无法聚合
→ 应该：msg="order failed", uid=123, item=456
```

### 排障时的高效查询

**ES/Kibana**：

```
service: "order-api" AND level: "error" AND trace_id: "abc123"
```

**Loki/LogQL**：

```logql
{app="order-api", env="prod"} |= "trace_id=abc123"
{app="order-api"} | json | level="error" | duration_ms > 1000
```

**ClickHouse**：

```sql
SELECT ts, level, msg FROM logs
WHERE service='order-api' AND level='error' AND ts > now() - INTERVAL 1 HOUR
ORDER BY ts DESC LIMIT 20;
```

**"先按 trace_id 拿全链路"是最有效的排障姿势**。

### 告警与日志的联动

```
① 错误率突增 → 告警带上"查询链接"（点开直接看日志）
② 每条告警里有 trace_id 或 request_id 样本
③ 日志里带上"变更版本号/发布时间"（便于关联变更）
```

**"告警里能直接点进日志"能省掉一半的排障时间**。

### 检查清单

```
□ 采集端：容器写 stdout，DaemonSet 采集
□ 日志结构化（JSON）+ 统一字段
□ ts 用 UTC ISO8601
□ trace_id 贯穿请求
□ 多行日志正确合并
□ Loki 标签只用低基数字段
□ ES 只对必要字段建索引
□ 有分层保留（热/冷）
□ 成本监控（存储量、写入量）
□ 告警带日志查询链接
□ 关键服务日志保留 ≥ 30 天
```
