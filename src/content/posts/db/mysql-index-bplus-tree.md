---
title: MySQL 索引为什么是 B+ 树：从回表代价讲起
description: 聚集索引与二级索引的区别决定了"回表"的代价，也决定了覆盖索引、最左前缀、索引下推这些优化为什么有效。
date: 2026-11-11
tags: [MySQL, 索引, B+树, 优化, 数据库]
---

"给字段加索引就快了"——这句话在二级索引上经常不成立。要理解为什么，得先理解 InnoDB 的两层索引结构。

## 一、两种索引，两种存储

InnoDB 的表数据本身就是一棵 B+ 树，按主键排序，叶子节点存**完整行**——这叫**聚集索引（clustered index）**。

二级索引（普通索引）是另一棵 B+ 树，叶子节点存的是**索引列 + 主键值**，不含整行。

```
主键索引叶子：  [id=1] → 完整行
二级索引叶子：  [name='tom'] → id=1
```

所以通过二级索引查整行，需要**拿主键再回主键索引查一次**，这就是回表（random I/O）。回表次数越多，索引的收益越容易被吃掉。

## 二、覆盖索引：让回表不发生

如果查询需要的列全在二级索引里，就不需要回表。

```sql
-- 需要回表（还要 name 之外的列）
SELECT id, name, email FROM users WHERE name = 'tom';

-- 覆盖索引：只取索引内已有的列
SELECT id, name FROM users WHERE name = 'tom';   -- id 是隐含的主键，天然在内
```

```sql
EXPLAIN SELECT id, name FROM users WHERE name = 'tom'\G
-- Extra: Using index  ← 出现这个就说明是覆盖索引
```

设计建议：高频查询列组合成**联合索引**，把 SELECT 中出现的列尽量包含进去，用"索引变宽"换"不回表"。

## 三、联合索引的最左前缀

联合索引 `(a, b, c)` 的排序是"先按 a，a 相同再按 b，再按 c"。因此：

| 条件 | 是否能用索引 |
| --- | --- |
| `a=1` | 用 a |
| `a=1 AND b=2` | 用 a,b |
| `a=1 AND b=2 AND c=3` | 全用 |
| `b=2` | **不能**（跳过了 a） |
| `a=1 AND c=3` | 用 a，c 无法走索引定位（5.6+ 可用索引下推过滤） |

范围条件会"截断"后续列：

```sql
-- a 用了范围，b 只能靠索引下推过滤，不能用于精确定位
WHERE a > 1 AND b = 2
```

所以**把等值条件放前、范围条件放后**，是联合索引排序的基本原则。

## 四、索引下推（ICP）

MySQL 5.6 引入：在存储引擎层就用索引中的列过滤，减少回表次数。

```sql
EXPLAIN ... -- Extra: Using index condition
```

例如 `(name, age)` 索引上 `WHERE name LIKE 'tom%' AND age > 20`，ICP 会在索引里先比 age，只有命中的才回表。

## 五、什么时候索引反而有害

1. **区分度低**：`status` 只有两个值，单独建索引几乎无用，选择度接近 50% 时优化器可能直接走全表。
2. **写多读少**：每个索引都要在写入时维护，索引越多写入越慢，还会放大 redo/binlog 体积。
3. **索引列参与计算或函数**：`WHERE DATE(created_at) = '2026-11-01'` 无法用索引，应改写成范围：`created_at >= '2026-11-01' AND created_at < '2026-11-02'`。
4. **隐式类型转换**：`WHERE phone = 13800000000`（整型）而 `phone` 是 varchar，会走全表。
5. **前缀模糊**：`LIKE '%abc'` 无法用 B+ 树定位，只能扫。

## 六、索引设计的可操作流程

1. 从慢查询日志里取 TOP SQL（`pt-query-digest` 或 `performance_schema`）。
2. 看 `EXPLAIN` 的 `type`（`ref`/`range` 较好，`ALL` 是全表）与 `rows`（估算扫描行数）。
3. 判断是否回表：`Extra` 里没有 `Using index` 就要考虑覆盖。
4. 设计联合索引，等值在前、范围在后，尽量把 SELECT 列纳入。
5. 上线前用 `EXPLAIN` + 实际耗时（`EXPLAIN ANALYZE`，8.0.18+）验证，并观察写入延迟是否上升。
6. 定期清理无用索引：`sys.schema_unused_indexes`。

```sql
-- 8.0 查看索引使用情况
SELECT object_schema, object_name, index_name FROM sys.schema_unused_indexes;
```

> 一句话：**索引不是"给列加个东西"，而是"按查询的形状重新组织一份数据副本"。形状不对，再多的索引也只是拖慢写入。**
