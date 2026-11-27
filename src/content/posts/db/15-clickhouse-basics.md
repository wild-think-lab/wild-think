---
title: ClickHouse 入门：什么时候该用它，什么时候别用
description: 与 MySQL 的本质差别、建表与分区设计、常见查询写法、写入与合并机制，以及"查得慢"的四个原因。
date: 2026-11-27
tags: [ClickHouse, OLAP, 数据库, 大数据]
---

### 本质差别

| | MySQL（OLTP） | ClickHouse（OLAP） |
| --- | --- | --- |
| 存储 | 行存 | **列存** |
| 擅长 | 点查、事务 | 聚合扫描（亿级） |
| 写入 | 随机、频繁 | **批量**（不建议单条） |
| 更新/删除 | 支持 | 弱（异步 mutation） |
| 事务 | 支持 | 不支持 |

**判断口诀**：

```
"我要查某个订单" → MySQL
"我要算过去一年的日活趋势" → ClickHouse
```

### 建表：选对引擎和分区

```sql
CREATE TABLE events (
    event_date  Date,
    event_time  DateTime,
    user_id     UInt64,
    event_type  LowCardinality(String),
    page        String,
    duration_ms UInt32
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, event_type, user_id)
TTL event_date + INTERVAL 180 DAY
SETTINGS index_granularity = 8192;
```

四个关键决策：

**① 引擎**：`MergeTree` 是基础，其他都是它的变体。

**② 分区键**：按月（`toYYYYMM`）或按天。**分区太多会拖慢**（建议总分区数 < 1000）。

**③ 排序键（ORDER BY）**：相当于主键索引，**查询条件里的高频字段放前面**。

**④ TTL**：自动删除过期数据，比手工删高效。

### 数据类型的选择

| 场景 | 类型 |
| --- | --- |
| 枚举/低基数 | `LowCardinality(String)` |
| 时间 | `Date` / `DateTime`（不要用字符串） |
| 金额 | `Decimal(18,2)`（不要 Float） |
| 可空 | 尽量避免 `Nullable`（有性能代价） |

`LowCardinality` 对"重复值多"的字段（如事件类型、地区）能显著压缩。

### 查询写法

**好的查询**：

```sql
SELECT
    event_date,
    count() AS pv,
    uniqExact(user_id) AS uv
FROM events
WHERE event_date BETWEEN '2026-01-01' AND '2026-11-30'
  AND event_type = 'page_view'
GROUP BY event_date
ORDER BY event_date;
```

**要点**：

```
① 时间范围放 WHERE 最前面（走分区裁剪）
② 不要 SELECT *（列存只读需要的列）
③ 高基数去重用 uniqExact（准确）或 uniq（近似，快）
```

**容易慢的写法**：

```sql
-- 慢：全表扫 + 字符串匹配
SELECT * FROM events WHERE page LIKE '%order%';

-- 快：用分区 + 排序键先过滤
SELECT count() FROM events
WHERE event_date >= today() - 7 AND event_type = 'order';
```

### 写入机制（必须理解）

```
① 每次 INSERT 生成一个新的"数据片段"（part）
② 后台线程异步合并（merge）小片段
③ 片段太多 → "too many parts" 报错
```

**所以：**

```
❌ 每秒 INSERT 一条（会积累海量小 part）
✅ 批量 INSERT（每批 1 万–10 万行）
```

批量写入示例：

```python
rows = []
for item in stream:
    rows.append(item)
    if len(rows) >= 50000:
        client.insert('events', rows, column_names=[...])
        rows = []
```

**"Too many parts" 的处理**：先停写入，等合并完成，再改批量大小。

### 更新与删除

```sql
-- 异步 mutation（会重写整个 part，代价高）
ALTER TABLE events DELETE WHERE event_type = 'test';
ALTER TABLE events UPDATE page = 'home' WHERE page = 'index';
```

**不要频繁用**：每次 mutation 都会重写大量数据。大批量删除用 TTL 或分区删除更快：

```sql
ALTER TABLE events DROP PARTITION '202601';
```

### "查得慢"的四个原因

| 原因 | 排查 |
| --- | --- |
| 没走分区裁剪 | `EXPLAIN` 看 `Partitions` 是否有大量分区 |
| 排序键没用上 | 查询条件与 ORDER BY 前缀不匹配 |
| 列太多 | `SELECT *` 读了所有列 |
| 片段太多（未合并） | `SELECT * FROM system.parts` 看 part 数量 |

```sql
-- 看查询用了多少分区、读了多少行
EXPLAIN SELECT ...;

-- 看各表的 part 数与大小
SELECT table, count() AS parts, sum(bytes_on_disk)/1e9 AS gb
FROM system.parts WHERE active GROUP BY table ORDER BY parts DESC;
```

### 一个实用的分层

```
原始明细（events，保留 180 天，TTL 自动删）
    ↓ 物化视图聚合
小时级汇总（events_hourly）
    ↓
天级汇总（events_daily，保留 3 年）
```

**查询走汇总表**，明细表只在"要下钻"时查。这是 ClickHouse 性能的关键用法。

物化视图：

```sql
CREATE MATERIALIZED VIEW events_daily
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(d)
ORDER BY (d, event_type)
AS SELECT
    toDate(event_time) AS d,
    event_type,
    count() AS pv,
    uniqState(user_id) AS uv_state
FROM events
GROUP BY d, event_type;
```

### 集群与副本

```
① 副本（Replica）：同一分片的多份，靠 ZooKeeper/ClickHouse Keeper 协调
② 分片（Shard）：数据水平切分，查询要经过 Distributed 表
```

```sql
CREATE TABLE events_dist AS events
ENGINE = Distributed('cluster', 'default', 'events', rand());
```

查询 `events_dist` 会自动分发到各分片并汇总。

### 检查清单

```
□ 明确是 OLAP 场景（不是点查）
□ 分区按月/天，总分区数 < 1000
□ ORDER BY 前缀匹配高频查询条件
□ 写入批量（不要单条）
□ 有 TTL 自动清理
□ 高频查询走物化视图汇总表
□ 监控 part 数量与合并延迟
□ 不用频繁 mutation 更新/删除
```
