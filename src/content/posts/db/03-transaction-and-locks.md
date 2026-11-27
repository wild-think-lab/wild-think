---
title: MySQL 事务与锁：为什么你的更新会超时
description: 从一次 "Lock wait timeout" 讲清 InnoDB 的行锁、间隙锁、隔离级别与死锁检测，给出可复现的实验和规避写法。
date: 2026-11-27
tags: [MySQL, 事务, 锁, 死锁, 数据库]
---

### 现场：一个不太常见的超时

```
ERROR 1205 (HY000): Lock wait timeout exceeded; try restarting transaction
```

它不代表数据库坏了，代表**有人在等一把锁，等了 `innodb_lock_wait_timeout`（默认 50 秒）还没拿到**。要解决它，必须先知道谁拿着锁。

```sql
-- 当前在等锁的事务
SELECT * FROM performance_schema.data_lock_waits\G
-- 锁的持有者
SELECT * FROM performance_schema.data_locks\G
-- 谁在跑长事务
SELECT trx_id, trx_state, trx_started, trx_query
FROM information_schema.innodb_trx
ORDER BY trx_started LIMIT 5;
```

三步固定顺序：**谁在等 → 谁持有 → 持有多久**。多数情况下会看到一个几分钟没提交的事务，它什么都不干，只是占着锁。

### 事务的四个特性，落到 InnoDB 是哪四件事

| 特性 | InnoDB 的实现 |
| --- | --- |
| 原子性 A | undo log（回滚段） |
| 一致性 C | 约束 + 应用逻辑（数据库只能保证一部分） |
| 隔离性 I | MVCC + 锁 |
| 持久性 D | redo log + `innodb_flush_log_at_trx_commit=1` |

真正需要你决策的只有隔离级别。

### 隔离级别与它带来的问题

| 级别 | 脏读 | 不可重复读 | 幻读 | MySQL 默认 |
| --- | --- | --- | --- | --- |
| READ UNCOMMITTED | 有 | 有 | 有 | 否 |
| READ COMMITTED | 无 | 有 | 有 | 否 |
| REPEATABLE READ | 无 | 无 | 基本无（间隙锁） | **是** |
| SERIALIZABLE | 无 | 无 | 无 | 否 |

MySQL 的 RR 靠 MVCC 快照 + 间隙锁把幻读压到"基本没有"。代价是**间隙锁会锁住范围**，两个不冲突的插入也可能互相阻塞。

### 行锁到底锁了什么

关键结论：**InnoDB 锁的是索引，不是行。**

- 有索引且命中 → 锁住索引记录（行锁）。
- 没有索引或索引失效 → 退化成**表级扫描锁**，锁住所有扫描到的记录，效果接近锁表。
- 唯一索引等值命中 → 只锁一行。
- 普通索引等值 → 锁索引记录 + 间隙。

所以"给 WHERE 条件加索引"不只是性能问题，也是**并发问题**。

### 可复现的死锁实验

开两个会话：

```sql
-- 会话 A
BEGIN;
UPDATE t SET v = 1 WHERE id = 1;
-- 先不提交

-- 会话 B
BEGIN;
UPDATE t SET v = 2 WHERE id = 2;

-- A 继续
UPDATE t SET v = 1 WHERE id = 2;   -- 等 B

-- B 继续
UPDATE t SET v = 2 WHERE id = 1;   -- 死锁，InnoDB 立刻回滚其中一个
```

```bash
# 看最近一次死锁详情
mysql -e "SHOW ENGINE INNODB STATUS\G" | sed -n '/LATEST DETECTED DEADLOCK/,/---/p'
```

InnoDB 有死锁检测，通常几毫秒就回滚代价小的那个事务。**死锁本身不是灾难，"没处理好重试"才是**。

### 五条能立刻降低锁冲突的写法

1. **事务要短**。不要在事务里调 RPC、发消息、等人工确认。
2. **按固定顺序加锁**。多表更新统一按主键升序，能消掉一大半死锁。
3. **用 `INSERT ... ON DUPLICATE KEY UPDATE` 或 `SELECT ... FOR UPDATE` 明确语义**，别靠"先查再改"。
4. **避免大范围 `UPDATE ... WHERE 无索引列`**，会锁全表。
5. **应用层做重试**：捕获 1205/1213，指数退避重试 2–3 次，比让用户看到报错好。

### 乐观锁 vs 悲观锁

- 悲观锁：`SELECT ... FOR UPDATE`，冲突多、强一致场景（余额扣减）。
- 乐观锁：版本号 `UPDATE t SET v=?, ver=ver+1 WHERE id=? AND ver=?`，冲突少、读多写少场景。

余额类场景别用乐观锁循环重试到天荒地老，直接悲观锁 + 短事务更省心。

### 参数与观测

```ini
innodb_lock_wait_timeout = 20          # 别设太大，等 50 秒的请求早该失败
innodb_deadlock_detect = ON            # 高并发下关掉会更慢，一般保持开
transaction_isolation = REPEATABLE-READ
```

```sql
SHOW GLOBAL STATUS LIKE 'Innodb_row_lock%';   -- 等锁次数与平均等待时间
SHOW GLOBAL STATUS LIKE 'Innodb_deadlocks';
```

`Innodb_row_lock_waits` 持续上涨就是要查的信号，别等它变成故障单。
