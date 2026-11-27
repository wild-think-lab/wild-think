---
title: 执行计划怎么读：EXPLAIN 里那几行到底在说什么
description: MySQL EXPLAIN 与 Postgres EXPLAIN ANALYZE 的读法、关键字段判据、五类"看着慢但其实不慢"的情形。
date: 2026-11-27
tags: [数据库, 性能, SQL]
---

### 先分清两种

```
EXPLAIN            → 估算（优化器的计划，不含真实耗时）
EXPLAIN ANALYZE    → 真实执行（会真的跑，PG 独有；MySQL 8.0.18+ 也支持）
```

**"只看 EXPLAIN 就断定慢"** 常误判（估算偏差很大）。

### MySQL 关键字段

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 1 ORDER BY created_at DESC LIMIT 10;
```

```
id            执行顺序（同 id 从上到下）
type          访问类型（最关键）
possible_keys 可能用的索引
key           实际用的索引
key_len       用了索引的多少列（判断"复合索引用了几列"）
rows          估算扫描行数
filtered      过滤后剩余比例
Extra         额外信息（Using filesort / Using temporary 等）
```

### type 的等级（从好到坏）

```
const        → 主键/唯一索引等值（最快）
eq_ref       → 联表用主键
ref          → 普通索引等值
range        → 范围扫描
index        → 扫整个索引（不一定慢，但要走完）
ALL          → 全表扫描（危险信号）
```

**"type=ALL 且 rows 很大"** → 缺索引或索引失效。

### Extra 里最该警惕的

```
Using filesort     → 排序没走索引（小数据无感，大数据致命）
Using temporary    → 用了临时表（group by / distinct / union）
Using index        → 覆盖索引（好）
Using where        → 拿到行后还要过滤（可能索引选择性差）
```

**"Using filesort + LIMIT 大偏移"** 是最常见的性能杀手：

```sql
-- 深分页
SELECT * FROM orders ORDER BY id DESC LIMIT 100000, 10;
-- 改成游标
SELECT * FROM orders WHERE id < 100000 ORDER BY id DESC LIMIT 10;
```

### key_len 判断"复合索引用了几列"

```
varchar(20) utf8mb4 → 每列约 20*4+2 = 82 字节
如果 key_len 只覆盖第一列 → 后续列没用上
```

**"建了 (a,b,c) 却只用 a"** → 检查查询条件顺序与范围条件位置。

### Postgres 的读法

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ...
```

```
Seq Scan        → 全表（小表正常）
Index Scan      → 走索引
Bitmap Heap Scan → 位图（中等选择性）
Nested Loop     → 小表驱动（rows 少时好）
Hash Join       → 大表连接（常见）
Sort / Hash     → 内存排序/哈希（注意 work_mem）
```

**关键指标**：

```
actual time=... rows=... loops=...
（loops 大且 rows 小 → 该改连接方式）
Buffers: shared hit=... read=...   （read 多 → 缓存不足）
```

**"估算 rows=1 实际 rows=10000"** → 统计信息过期（`ANALYZE`）。

### 五类"看着慢但其实不慢"

**① 大表全扫但只 100 行**

```
小表 Seq Scan 比 Index Scan 更快（避免随机 IO）
```

**② Using filesort 但数据量小**

```
排序 20 行 < 1ms，不用管
```

**③ rows 估算大但 filtered 高**

```
实际扫的行数远小于估算
```

**④ 计划里有 Sort，但内存足够**

```
work_mem 够 → 内存排序，不落盘
```

**⑤ 多个计划，优化器选了"看起来差"的**

```
可能是成本模型正确（随机 IO 代价）
```

### 什么时候该动索引

```
① type=ALL 且 rows > 万级
② Using filesort 且排序字段是高频查询
③ 复合索引 key_len 不足
④ 范围条件放在复合索引前面导致后面列失效
```

**"加索引"的代价**：

```
写入变慢、占用空间、可能让优化器选错
→ 索引要"按查询建"，不是"按列建"
```

### 一个稳定的排查流程

```
1) 找到慢 SQL（慢日志/pg_stat_statements）
2) EXPLAIN ANALYZE 看真实耗时在哪
3) 判断"扫描多"还是"排序贵"还是"连接差"
4) 改 SQL 或加索引或调参数（work_mem/buffer pool）
5) 复测（同一数据集、同一并发）
```

### 检查清单

```
□ 会用 EXPLAIN ANALYZE（不只看估算）
□ 能读 type / Extra / key_len
□ 知道深分页改游标
□ 会看 PG 的 loops 与 Buffers
□ 统计信息定期更新
□ 索引按查询建（复合列顺序正确）
□ 改索引前评估写入影响
□ 有慢 SQL 采集（慢日志/stat_statements）
□ 复测用同一条件
□ 结论落到"具体改动 + 预期收益"
```
