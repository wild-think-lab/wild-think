---
title: ClickHouse 速查
description: 建表、写入、查询、运维命令与常见优化的一句话版本。
summary: 引擎选择、排序键、分区、物化视图与系统表，一张纸覆盖日常操作。
group: data
order: 3
tags: [ClickHouse, OLAP, 数据库]
---

### 建表（最常用模板）

```sql
CREATE TABLE app.logs (
    ts       DateTime,
    level    LowCardinality(String),
    service  LowCardinality(String),
    trace_id String,
    msg      String,
    dur_ms   UInt32
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (service, level, ts)
TTL ts + INTERVAL 30 DAY;
```

### 引擎速查

| 引擎 | 用途 |
| --- | --- |
| `MergeTree` | 基础（有序、分区） |
| `ReplicatedMergeTree` | 带副本 |
| `ReplacingMergeTree` | 按排序键去重（保留最后一条） |
| `SummingMergeTree` | 自动合并数值列（配合物化视图） |
| `AggregatingMergeTree` | 存 `-State` 聚合中间态 |
| `Distributed` | 分布式入口表 |
| `Kafka` | 从 Kafka 消费写入 |
| `Buffer` | 内存缓冲（小批写合并） |
| `Memory` | 内存表（临时/小字典） |

### 常用类型

```sql
UInt8 / UInt32 / UInt64       -- 无符号整数（首选，省空间）
Int32                          -- 有符号
Float64 / Decimal(18,4)        -- 金额用 Decimal
String                         -- 通用字符串
LowCardinality(String)         -- 低基数（< 10 万不同值）
Date / DateTime / DateTime64(3)
Array(T)                       -- 数组
Nullable(T)                    -- 尽量避免（有额外开销）
Map(String, String)            -- 稀疏键值
```

**金额用 `Decimal`**，不要用 Float（精度问题）。

### 写入

```sql
INSERT INTO app.logs VALUES (...), (...);   -- 批量（一次多行）
INSERT INTO app.logs SELECT ... FROM ...;   -- 从查询写
```

**建议**：

```
① 每批 ≥ 1000 行（或每 1–5 秒一批）
② 不要逐条 insert
③ 用 Buffer 表或 Kafka 表做缓冲
```

### 查询常用

```sql
-- 时间过滤（必带分区）
SELECT * FROM app.logs WHERE ts >= now() - INTERVAL 1 HOUR;

-- 聚合
SELECT service, count() AS cnt FROM app.logs
WHERE ts >= today() - 1 GROUP BY service ORDER BY cnt DESC LIMIT 10;

-- 去重计数（近似）
SELECT uniq(trace_id) FROM app.logs WHERE ts >= today() - 1;

-- 精确去重（贵）
SELECT uniqExact(trace_id) FROM app.logs;

-- 分位
SELECT quantile(0.99)(dur_ms) FROM app.logs;

-- Top-N 每组
SELECT service, ts, dur_ms FROM app.logs
ORDER BY dur_ms DESC LIMIT 5 BY service;

-- 采样
SELECT count() FROM app.logs SAMPLE 0.1;
```

**`LIMIT n BY x` 是 ClickHouse 特有的"每组取前 n"**，非常实用。

### 物化视图（预聚合）

```sql
CREATE MATERIALIZED VIEW app.mv_err_daily
ENGINE = SummingMergeTree
PARTITION BY day
ORDER BY (service, level, day)
AS SELECT
  toDate(ts) AS day,
  service,
  level,
  count() AS cnt
FROM app.logs
WHERE level = 'ERROR'
GROUP BY day, service, level;
```

**注意**：

```
① 物化视图只处理"新写入"，不回填历史
② 回填：INSERT INTO mv SELECT ...（要临时改名避免重复）
③ state 函数：countState / sumState + countMerge / sumMerge
```

### 修改表

```sql
-- 加列（很轻，只改元数据）
ALTER TABLE app.logs ADD COLUMN region LowCardinality(String) DEFAULT '';

-- 改 TTL
ALTER TABLE app.logs MODIFY TTL ts + INTERVAL 90 DAY;

-- 删除分区
ALTER TABLE app.logs DROP PARTITION '20260901';

-- 删除数据（mutation，重写 part，慎用）
ALTER TABLE app.logs DELETE WHERE service = 'old';
```

**`ALTER ... ADD COLUMN` 是"元数据操作"，几乎零成本**（这是列存的优势）。

### 运维诊断

```sql
-- 表大小
SELECT table, formatReadableSize(sum(bytes_on_disk)) sz, sum(rows) rows
FROM system.parts WHERE active AND database='app'
GROUP BY table ORDER BY sum(bytes_on_disk) DESC;

-- part 数量（过多要警惕）
SELECT table, count() parts FROM system.parts WHERE active GROUP BY table;

-- 慢查询
SELECT query_duration_ms, memory_usage, query
FROM system.query_log
WHERE type='QueryFinish' AND query_duration_ms > 1000
ORDER BY query_duration_ms DESC LIMIT 10;

-- 正在跑
SELECT query_id, elapsed, read_rows, memory_usage, query FROM system.processes;

-- 杀掉
KILL QUERY WHERE query_id = 'xxx';

-- 副本状态（复制表）
SELECT table, is_leader, absolute_delay FROM system.replicas;

-- 磁盘
SELECT name, formatReadableSize(free_space) free, formatReadableSize(total_space) total
FROM system.disks;
```

### 内存与并发控制

```sql
SET max_memory_usage = 5000000000;         -- 单查询 5G
SET max_threads = 8;
SET max_execution_time = 60;               -- 秒
SET max_result_rows = 100000;
```

**"OOM killed"** → 查 `system.query_log` 里 memory_usage 最高的那条。

### 参数（服务器级）

```xml
<!-- users.xml -->
<max_memory_usage>10000000000</max_memory_usage>
<max_memory_usage_for_all_queries>30000000000</max_memory_usage_for_all_queries>
<max_concurrent_queries>200</max_concurrent_queries>
```

### 常见优化

```
① ORDER BY 按查询模式（等值字段在前）
② 低基数字段用 LowCardinality
③ 避免 SELECT *（列存要读所有列）
④ JOIN 小表放右边
⑤ 大 GROUP BY 用 uniq 而非 count(distinct)
⑥ 批量写入（≥1000 行/批）
⑦ 用物化视图预聚合
⑧ 分区数控制在 100–1000
⑨ 不滥用 Nullable
⑩ 金额用 Decimal 而非 Float
```

### 坑

```
① Mutation（ALTER DELETE/UPDATE）重写 part → 慢且占 IO
② 分区太多 → 元数据与 merge 压力
③ 小文件（part）太多 → 查询打开大量文件
④ JOIN 大表可能 OOM
⑤ 分布式表写入会二次转发（用本地表直写更快）
⑥ 不支持事务（认清定位）
```
