---
title: 数据库岗面试：从索引到"这条 SQL 为什么慢"
description: 高频题的分层答法、索引失效的六种情形、事务隔离的真实表现、分库分表的判断标准，以及"如何优化"的完整思路。
date: 2026-11-27
tags: [面试, 数据库, MySQL, 索引]
---

### 分层答法

```
① 概念层：索引是什么、隔离级别有几种
② 原理层：为什么 B+ 树、为什么不可重复读会发生
③ 场景层：这条 SQL 为什么慢、这个索引为什么没走
```

**只答概念会被判定"背的"**，一定要能讲场景。

### 索引：三个必知的点

**① 为什么是 B+ 树**

```
B 树：数据在每个节点 → 一次查询可能要在节点和叶子都匹配
B+ 树：只有叶子存数据，叶子间有链表
  → 范围查询快（沿链表扫）
  → 树更矮（非叶子只存 key，一次 IO 读更多 key）
  → 查询稳定（都要到叶子）
```

**② 回表与覆盖索引**

```sql
-- 有索引 idx_name(name)，这条要回表
SELECT id, age FROM t WHERE name = 'alice';   -- id 是主键，但 age 不在索引里

-- 覆盖索引：索引里就有全部需要的列，不需要回表
ALTER TABLE t ADD INDEX idx_name_age(name, age);
SELECT name, age FROM t WHERE name = 'alice';  -- Extra: Using index
```

**③ 最左前缀**

```sql
-- 索引 (a, b, c)
WHERE a=1                 -- 用上
WHERE a=1 AND b=2         -- 用上
WHERE a=1 AND c=3         -- 只用 a
WHERE b=2                 -- 用不上（跳过 a）
WHERE a=1 AND b>2 AND c=3 -- c 用不上（范围之后失效）
```

### 索引失效的六种情形

```sql
-- ① 对索引列做函数/运算
WHERE DATE(created_at) = '2026-11-27'        -- 失效
WHERE created_at >= '2026-11-27 00:00:00'    -- 走索引

-- ② 隐式类型转换
WHERE user_id = '123'        -- user_id 是 int → 可能失效
WHERE id = 123

-- ③ 前导模糊
WHERE name LIKE '%abc'       -- 失效
WHERE name LIKE 'abc%'       -- 走索引

-- ④ OR 两边有一边没索引
WHERE a = 1 OR b = 2         -- b 没索引 → 可能全表扫

-- ⑤ 不等于 / NOT IN
WHERE status != 'paid'       -- 常退化为全表扫（视数据分布）

-- ⑥ 索引选择性差
-- 性别字段建索引，几乎没用（区分度太低）
```

**加分回答**：提到"优化器可能因为 `cost` 判断而主动不选索引（如 `LIMIT` 小、数据量小、或者统计信息过期）"，能体现真实经验。

### 事务与隔离级别

| 级别 | 脏读 | 不可重复读 | 幻读 |
| --- | --- | --- | --- |
| READ UNCOMMITTED | 可能 | 可能 | 可能 |
| READ COMMITTED | 不会 | 可能 | 可能 |
| REPEATABLE READ（MySQL 默认） | 不会 | 不会 | **InnoDB 用 MVCC + 间隙锁基本避免** |
| SERIALIZABLE | 不会 | 不会 | 不会 |

**高频追问**："RR 是怎么避免幻读的？"

```
① 快照读（普通 SELECT）：MVCC，读到事务开始时的快照
② 当前读（SELECT FOR UPDATE / UPDATE）：间隙锁（Gap Lock）+ 行锁
```

**注意**：RR 下"快照读"仍可能看到"旧快照"，这是 MVCC 的设计（不是 bug）。

### "这条 SQL 为什么慢"的标准答法

```
① 先 EXPLAIN（看 type / key / rows / Extra）
② 判断是"没走索引"还是"走了但扫描行数多"
③ 没走索引 → 查索引失效原因（函数、隐式转换、最左前缀）
④ 走了但慢 → 看是否回表多、是否排序/临时表
⑤ 数据量本身大 → 考虑分区/归档/加缓存
⑥ 是锁等待 → 看 innodb_trx 与 data_lock_waits
```

示例：

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 100 AND status = 'paid' ORDER BY created_at DESC LIMIT 20;
-- type: ref, key: idx_user, rows: 5000, Extra: Using filesort  ← 问题在 filesort
```

**优化**：

```sql
-- 建联合索引，覆盖过滤 + 排序
ALTER TABLE orders ADD INDEX idx_user_status_time(user_id, status, created_at);
-- 再次 EXPLAIN：Extra 里 filesort 消失
```

### 分库分表的判断

```
什么时候需要分：
① 单表 > 5000 万行 或 单库 > 500G（经验值，不是绝对）
② 写入 QPS 超过单机能力
③ 单库连接数打满
④ 备份/DDL 时间不可接受（小时级）
```

**先做这四件事再考虑分**：

```
① 加索引与优化 SQL
② 加缓存（Redis）
③ 读写分离（从库分担读）
④ 归档历史数据（冷数据迁走）
```

**分片键的选择**：

```
按 user_id 分：同一用户的数据在同一片（查询友好）
按时间分：天然适合归档，但热点集中在新分片
```

**分表后的代价**（必须说清）：

```
- 跨片 JOIN 不可用（要在应用层聚合）
- 分布式事务变复杂
- 全局唯一 ID 需要方案（雪花/号段）
- 扩容要迁移数据
```

### 高频"送命题"

| 题 | 要点 |
| --- | --- |
| 为什么不用 UUID 做主键 | 随机 → 插入时 B+ 树分裂多、索引大、缓存命中低 |
| 主键为什么建议自增 | 顺序插入，页分裂少 |
| count(*) 为什么慢 | 要扫全部行；`count(1)` 同；用近似值或维护计数表 |
| 大表加字段怎么做 | 8.0 支持 instant add column（元数据变更）；否则用 gh-ost/pt-osc |
| 为什么慢查询日志里看不到 | `long_query_time` 设太大 / 未开 `log_queries_not_using_indexes` |
| 主从延迟怎么解决 | 并行复制、拆大事务、关键读走主 |

### 反问

```
① 你们最大的表多少行？分库分表了吗？
② 线上 DDL 怎么做的？（gh-ost / pt-osc / 原生）
③ 主从延迟的告警阈值是多少？
```

### 检查清单（面试前）

```
□ 能讲清 B+ 树与回表
□ 能立刻说出 6 种索引失效情形
□ 能解释 RR 下幻读如何被抑制
□ 有一套"SQL 慢"的排查顺序
□ 知道分库分表前该先做哪四件事
□ 有 1 个真实的慢查询优化案例（带数字）
```
