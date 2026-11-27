---
title: 索引与 EXPLAIN：为什么这条 SQL 慢
module: 熟练篇
summary: B+ 树索引为什么能加速、哪种写法会让索引失效、EXPLAIN 的每一列怎么读，以及一个从慢查询到加对索引的完整流程。
minutes: 14
---

### 索引为什么快

没有索引：数据库从第一行扫到最后一行（全表扫描）。100 万行 × 每行 1KB = 1GB 数据要读一遍。

有索引：B+ 树，3–4 层就能定位到目标行，只读几个 16KB 页。

代价：**索引本身占空间、写入时要维护索引**。所以索引是"用写换读"。

### 什么时候索引不生效

这是最高频的问题。以下写法会让索引白建：

| 写法 | 为什么失效 | 改法 |
| --- | --- | --- |
| `WHERE name LIKE '%张%'` | 左侧通配无法定位起点 | 用全文索引或前置匹配 `LIKE '张%'` |
| `WHERE id + 1 = 100` | 列被计算 | `WHERE id = 99` |
| `WHERE DATE(created_at) = '2026-11-27'` | 列被函数包裹 | `WHERE created_at >= '2026-11-27' AND created_at < '2026-11-28'` |
| `WHERE status != 1` | 不等于无法用索引定位 | 改成 `IN (0,2,3)` 或加覆盖条件 |
| `WHERE name = 123`（name 是 varchar） | 类型隐式转换 | 参数类型对齐 |
| `WHERE a = 1 OR b = 2` | 有一侧无索引 | 拆成两条 UNION |
| `ORDER BY` 的列与索引顺序不一致 | 无法利用索引排序 | 让 ORDER BY 与最左前缀匹配 |

### 联合索引与最左前缀

```sql
KEY idx_abc (a, b, c)
```

| 查询条件 | 用到索引吗 |
| --- | --- |
| `WHERE a = 1` | 用 a |
| `WHERE a = 1 AND b = 2` | 用 a,b |
| `WHERE b = 2` | 不用 |
| `WHERE a = 1 AND c = 3` | 只用 a |
| `WHERE a > 1 AND b = 2` | 用 a（范围后失效） |

**范围条件会截断后续列**，这解释了"我明明建了三列联合索引却只用上一列"。

### EXPLAIN 怎么读

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 1001 AND status = 1;
```

```
+----+-------------+--------+------+---------------+---------+---------+------+
| id | select_type | table  | type | possible_keys | key     | rows    | Extra|
+----+-------------+--------+------+---------------+---------+---------+------+
|  1 | SIMPLE      | orders | ref  | idx_user...   | idx_... |      12 | NULL |
```

只记四列：

**1. `type`（访问类型，从好到坏）**

| type | 含义 | 评价 |
| --- | --- | --- |
| `const` / `eq_ref` | 主键/唯一索引等值 | 最好 |
| `ref` | 普通索引等值 | 好 |
| `range` | 索引范围扫描 | 可接受 |
| `index` | 扫整个索引 | 一般，数据量大时慢 |
| `ALL` | 全表扫描 | 要处理 |

**2. `rows`**：预估扫描行数。rows 越大越慢。如果 rows 是 100 万而实际只要 10 行，索引就没起作用。

**3. `key`**：实际用了哪个索引。为空 = 没用索引。

**4. `Extra`**：

- `Using index`：覆盖索引，不回表，最好。
- `Using where`：拿到索引后又过滤，正常。
- `Using temporary`：用了临时表（GROUP BY / DISTINCT 常见），要优化。
- `Using filesort`：额外排序，数据量大时很慢。

### 覆盖索引：最便宜的优化

```sql
-- 查询只要两列，索引里就有
KEY idx_user_status_amount (user_id, status, amount)

SELECT user_id, status, amount FROM orders WHERE user_id = 1001;
-- Extra: Using index（不回表）
```

代价是索引变宽。用"高频查询的少量列"换掉回表，通常划算。

### 一个完整的排查流程

1. **开慢查询日志**

```ini
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 1
```

```bash
mysqldumpslow -s t -t 10 /var/log/mysql/slow.log    # 按总耗时排前 10
```

2. **拿到具体 SQL**，用 `EXPLAIN` 看 `type/rows/key/Extra`。
3. **判断**：全表扫（ALL）→ 找条件列建索引；`Using filesort` → 让排序走索引；`rows` 巨大 → 条件或索引选择错。
4. **加索引后对比** `EXPLAIN` 的 rows 与实测耗时。
5. **观察写入影响**（插入/更新是否变慢）。

### 加索引的正确姿势

```sql
-- 大表加索引会锁表（MySQL 8 的 online DDL 部分场景不锁，但要确认）
ALTER TABLE orders ADD INDEX idx_user_status (user_id, status), ALGORITHM=INPLACE, LOCK=NONE;
```

大表变更建议走 gh-ost 或 pt-online-schema-change，且避开业务高峰。

### 本章验证

1. 造一张 100 万行的测试表，对比有索引/无索引的查询耗时。
2. 写三条会让索引失效的 SQL，用 `EXPLAIN` 证明 `type=ALL`，再改对。
3. 用覆盖索引把一条查询的 `Extra` 变成 `Using index`。

索引优化的核心不是"多加索引"，而是**让查询形状和索引形状对齐**。
