---
title: 增删改查：把 SQL 写对，而不是写多
module: 入门篇
summary: SELECT 的执行顺序、WHERE 与 JOIN 的正确用法、UPDATE 为什么要先 SELECT、批量操作怎么不锁表。每段都给出"写错会怎样"。
minutes: 13
---

### 先理解执行顺序

SQL 写起来是 `SELECT ... FROM ... WHERE ...`，但数据库执行顺序是：

```
FROM / JOIN → WHERE → GROUP BY → HAVING → SELECT → ORDER BY → LIMIT
```

这解释了两件常被问的事：

- 为什么 `WHERE` 里不能用 `SELECT` 起的别名？——WHERE 在 SELECT 之前执行。
- 为什么 `ORDER BY` 能用别名？——它在 SELECT 之后。
- 为什么 `LIMIT 10 OFFSET 100000` 很慢？——它要先取出前 100010 行再丢掉。

### 查询：先想清楚"要哪些行、哪些列"

```sql
SELECT id, order_no, amount
FROM orders
WHERE user_id = 1001
  AND status = 1
ORDER BY created_at DESC
LIMIT 20;
```

四个习惯：

1. **不要 `SELECT *`**：多取字段会让网络与缓存都变慢，且表结构变了容易出错。
2. **条件列要有索引**（下一章讲）。
3. **分页用游标**：深翻页用 `WHERE id < last_id ORDER BY id DESC LIMIT 20`，而不是 `OFFSET 100000`。
4. **时间范围要显式**：报表类查询一定带 `created_at >= ?`，否则扫全表。

### JOIN：三种连接的实际差别

```sql
-- 内连接：两边都有的行
SELECT o.id, u.name
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 1;

-- 左连接：以左表为准，右表没有则补 NULL
SELECT u.id, COUNT(o.id) AS cnt
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id;
```

规则：

- **关联列必须类型一致且有索引**（`o.user_id` 和 `u.id`）。类型不一致（`BIGINT` vs `VARCHAR`）会退化成全表扫描。
- 超过 3 张表 JOIN 时要停下来想想：是不是该在应用层拼，或用冗余字段换性能。
- `LEFT JOIN` 后接 `WHERE 右表条件` 会退化成内连接——要放 `ON` 里。

```sql
-- 错：把 LEFT JOIN 变成 INNER JOIN
LEFT JOIN orders o ON o.user_id = u.id WHERE o.status = 1
-- 对：条件放 ON
LEFT JOIN orders o ON o.user_id = u.id AND o.status = 1
```

### 新增：一条 INSERT 的两种写法

```sql
-- 单条
INSERT INTO orders (order_no, user_id, amount, status) VALUES ('NO20261127001', 1001, 99.00, 0);

-- 批量（一条语句插 1000 行，比循环插快 10 倍以上）
INSERT INTO orders (order_no, user_id, amount, status) VALUES
('NO001', 1001, 99.00, 0),
('NO002', 1002, 199.00, 0)
ON DUPLICATE KEY UPDATE amount = VALUES(amount);
```

批量插入的两个限制：单条语句不要超过约 5000 行（太大反而慢且占锁），且要按主键递增顺序插入，页分裂最少。

### 更新：先 SELECT 再 UPDATE

```sql
-- 第一步：确认影响范围
SELECT id, status FROM orders WHERE status = 0 AND created_at < '2026-11-01';

-- 第二步：再改，并带条件
UPDATE orders
SET status = 2, updated_at = NOW(3)
WHERE status = 0 AND created_at < '2026-11-01';
```

**`UPDATE` 的危险在于条件写错就全表改**，而 MySQL 不会提示"你影响 50 万行"。习惯：

- 先 `SELECT` 看行数与样本。
- 大表分批：`WHERE id BETWEEN ? AND ?`，每批 1000 行，批间 sleep 一下。
- 别在业务高峰做大范围更新（会长时间持锁、产生大量 binlog）。

### 删除：`DELETE` 与 `TRUNCATE` 的取舍

```sql
DELETE FROM orders WHERE status = 3 AND created_at < '2026-01-01' LIMIT 1000;  -- 可分批、可回滚
TRUNCATE TABLE tmp_import;                                                     -- 清空，不可回滚
```

- `DELETE` 逐行删，会写 binlog，可以按时间点恢复。
- `TRUNCATE` 直接重建表，快但不可恢复，也不能带 WHERE。
- 物理删除前，先确认有备份，或先 `UPDATE status = -1` 软删除。

### 分页、排序与统计

```sql
SELECT DATE(created_at) AS day, COUNT(*) AS cnt, SUM(amount) AS total
FROM orders
WHERE created_at >= '2026-11-01' AND created_at < '2026-12-01'
GROUP BY day
ORDER BY day;
```

注意：`GROUP BY` 用到的列最好有索引；`COUNT(DISTINCT x)` 很贵，大数据量下改用近似或预聚合。

### 本章验证

1. 用 `EXPLAIN` 看你写的 JOIN 有没有走索引（下一章细讲）。
2. 把一次 `OFFSET 100000` 的分页改成游标分页，对比耗时。
3. 写一条会误伤全表的 `UPDATE`，然后加条件重写，体会差别。

SQL 写得对的标准不是"能查出结果"，而是**在大数据量下仍然不拖垮数据库**。
