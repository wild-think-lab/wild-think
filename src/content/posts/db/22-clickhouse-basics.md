---
title: ClickHouse 上手：把 10 亿行日志查成 1 秒
description: 表引擎怎么选、分区与排序键设计、六个让查询慢十倍的反模式，以及和 MySQL 的分工。
date: 2025-09-22
tags: [ClickHouse, 数据库, 大数据]
---

### 它和 MySQL 的分工

```
MySQL      ：点查、事务、强一致
ClickHouse ：大宽表扫描、聚合、明细查询（OLAP）
```

**别拿 ClickHouse 当 MySQL 用**：

```
① 不支持事务（没有回滚）
② 单条 UPDATE/DELETE 很慢（要改整个 part）
③ 点查（按主键取一行）不如 MySQL
④ JOIN 能力有限（大表 JOIN 要谨慎）
```

### 表引擎怎么选

**最常用三个**：

```
MergeTree         ：基础引擎（有序、可分区、可索引）
ReplicatedMergeTree：带副本（ZooKeeper/ClickHouse Keeper 协调）
Distributed       ：分布式表（查询入口，转发到本地表）
```

**标准架构**：

```
每个分片：ReplicatedMergeTree 本地表（xxx_local）
全集群  ：Distributed 表（xxx）指向各分片的本地表
```

```sql
-- 本地表（每个分片各一份）
CREATE TABLE logs_local ON CLUSTER cluster (
    ts        DateTime,
    level     LowCardinality(String),
    service   LowCardinality(String),
    msg       String
) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/logs', '{replica}')
PARTITION BY toYYYYMMDD(ts)
ORDER BY (service, level, ts);

-- 分布式表（查询入口）
CREATE TABLE logs ON CLUSTER cluster AS logs_local
ENGINE = Distributed(cluster, default, logs_local, rand());
```

**`LowCardinality` 是关键优化**：低基数字符串（如 level）用字典编码，省大量空间与扫描时间。

### 排序键（ORDER BY）是性能的核心

```
ClickHouse 没有传统二级索引
它靠"排序键 + 稀疏主键索引 + 跳数索引"来剪枝
```

**选排序键的规则**：

```
① 最常用的过滤字段放前面
② 基数适中（不要放 user_id 这种百万基数字段在最前）
③ 时间通常放较后（如果用分区已经按天切了）
```

**例**：

```sql
-- 查询大多是 WHERE service='api' AND level='error' AND ts > ...
ORDER BY (service, level, ts)     -- 正确
ORDER BY (ts)                     -- 差（无法按 service 剪枝）
ORDER BY (msg)                    -- 极差（String 高基数）
```

**分区键（PARTITION BY）**：

```
按天/按月分区（toYYYYMMDD / toYYYYMM）
分区数量控制在 100–1000 之间（太多会拖慢元数据）
```

**"分区过多"的后果**：

```
每个分区是一批 part
part 太多 → 后台 merge 压力大 → 查询要打开大量文件
```

### 六个让查询慢十倍的反模式

**① `SELECT *`**

```
ClickHouse 是列存，但 SELECT * 会把所有列都读一遍
→ 只读需要的列，速度快几倍
```

**② 高基数 GROUP BY**

```sql
SELECT user_id, count() FROM logs GROUP BY user_id;  -- 百万组
```

**处理**：

```
① 用 uniq() 而不是 count(distinct)（近似去重，快很多）
② 用 -State/-Merge 聚合函数（物化视图预聚合）
③ 分页/采样（SAMPLE 子句）
```

**③ 大表 JOIN**

```sql
SELECT * FROM big_a JOIN big_b ON big_a.k = big_b.k;   -- 可能 OOM
```

**处理**：

```
① 小表放右边（ClickHouse 会广播右表）
② 用 GLOBAL JOIN（分布式场景）
③ 大表 JOIN 改用"预聚合 + 关联 key 冗余"
```

**④ 按字符串做范围过滤**

```sql
WHERE msg LIKE '%timeout%'    -- 全扫描，无法剪枝
```

**处理**：

```
① 用 tokenbf 跳数索引（对分词字段）
② 提取关键字段（如 error_code）单独建列
③ 用 bitmap 索引
```

**⑤ 频繁小批量写入**

```
每秒 insert 一条 → 产生大量小 part → merge 压力爆炸
```

**处理**：

```
① 攒批（每批 1000+ 行，或每 1–5 秒一批）
② 用 Buffer 表或 Kafka 表引擎做缓冲
③ 控制 part 数量（system.parts 监控）
```

**⑥ 用 Mutation 做大规模更新**

```sql
ALTER TABLE logs UPDATE status=1 WHERE ...;   -- 重写整个 part
```

**处理**：改用"重建表 + 换名"或"写入新版本 + 查询时取最新"。

### 物化视图（预聚合）

```sql
CREATE MATERIALIZED VIEW mv_errors_daily
ENGINE = SummingMergeTree
PARTITION BY toYYYYMMDD(day)
ORDER BY (service, level, day)
AS SELECT
    toDate(ts) AS day,
    service,
    level,
    count() AS cnt
FROM logs
WHERE level = 'error'
GROUP BY day, service, level;
```

**注意**：

```
① 物化视图只处理"新写入"的数据（不回填历史）
② 要回填需手动 INSERT SELECT
③ 聚合要用对应的 -State 函数（如 countState）
```

### 常用运维命令

```sql
-- 磁盘与表大小
SELECT database, table, formatReadableSize(sum(bytes)) AS size
FROM system.parts WHERE active GROUP BY 1,2 ORDER BY size DESC LIMIT 10;

-- part 数量（过多要警惕）
SELECT table, count() AS parts FROM system.parts WHERE active GROUP BY table;

-- 慢查询
SELECT query, query_duration_ms, memory_usage
FROM system.query_log
WHERE type='QueryFinish' AND query_duration_ms > 1000
ORDER BY query_duration_ms DESC LIMIT 10;

-- 正在跑的查询
SELECT query_id, elapsed, read_rows, memory_usage, query FROM system.processes;

-- 杀掉查询
KILL QUERY WHERE query_id = 'xxx';
```

**`system.query_log` 是排查的第一入口**。

### 内存控制

```xml
<!-- users.xml -->
<max_memory_usage>10000000000</max_memory_usage>  <!-- 单查询 10G -->
<max_memory_usage_for_all_queries>30000000000</max_memory_usage_for_all_queries>
```

**"OOM killed" 常见原因**：

```
① 大 GROUP BY（基数爆炸）
② 大 JOIN（右表太大）
③ 未加 LIMIT 的 ORDER BY
④ 用了 String 而非 LowCardinality
```

**应急**：

```sql
SET max_memory_usage = 2000000000;
SET max_threads = 4;
```

### TTL 自动清理

```sql
ALTER TABLE logs_local ON CLUSTER cluster
MODIFY TTL ts + INTERVAL 30 DAY;
```

**TTL 是"低成本保留策略"**，比定时删除友好得多（后台异步清理）。

### 检查清单

```
□ MergeTree + 分区（按天/月）
□ 排序键按查询模式设计（常用过滤在前）
□ 低基数字段用 LowCardinality
□ 分区数控制在 100–1000
□ 批量写入（不要逐条）
□ 预聚合用物化视图
□ 避免大表 JOIN / SELECT *
□ uniq 代替 count(distinct)
□ 配 TTL 自动清理
□ 监控 part 数量与 system.query_log
□ 设置内存上限（防 OOM）
□ 不做事务性操作（认清定位）
```
