---
title: 事务与锁：并发下怎么不写坏数据
module: 熟练篇
summary: 转账为什么必须在一个事务里、锁等待超时怎么查、死锁为什么不是灾难。三个可复现的实验加四条例规避写法。
minutes: 13
---

### 一个必须用事务的场景

```sql
-- 转账：从 A 扣 100，给 B 加 100
UPDATE account SET balance = balance - 100 WHERE id = 1;
UPDATE account SET balance = balance + 100 WHERE id = 2;
```

如果第一条成功、第二条失败（断电、报错），钱就消失了。

```sql
START TRANSACTION;
UPDATE account SET balance = balance - 100 WHERE id = 1;
UPDATE account SET balance = balance + 100 WHERE id = 2;
COMMIT;   -- 或 ROLLBACK
```

事务保证：**要么两条都成，要么都不成**。

### 事务的四个特性在 MySQL 里是什么

| 特性 | 实现 |
| --- | --- |
| 原子性 | undo log（可以回滚） |
| 一致性 | 约束 + 你的业务逻辑 |
| 隔离性 | MVCC + 锁 |
| 持久性 | redo log（`innodb_flush_log_at_trx_commit=1`） |

数据库只能保证 A、I、D，"C（一致性）"有一半要靠你的代码。

### 隔离级别与它防的问题

| 级别 | 脏读 | 不可重复读 | 幻读 |
| --- | --- | --- | --- |
| READ UNCOMMITTED | 有 | 有 | 有 |
| READ COMMITTED | 无 | 有 | 有 |
| REPEATABLE READ（默认） | 无 | 无 | 基本无 |
| SERIALIZABLE | 无 | 无 | 无 |

MySQL 的 RR 靠 MVCC 快照读 + 间隙锁实现。代价是**间隙锁会锁范围**，两个不冲突的插入可能互相等。

```sql
SELECT @@transaction_isolation;
SET SESSION transaction_isolation = 'READ-COMMITTED';   -- 有的业务更适合 RC
```

### 锁等待超时怎么查

```
ERROR 1205: Lock wait timeout exceeded
```

```sql
-- 谁在等
SELECT * FROM performance_schema.data_lock_waits\G
-- 谁持有
SELECT * FROM performance_schema.data_locks\G
-- 有没有长事务
SELECT trx_id, trx_state, trx_started, trx_query
FROM information_schema.innodb_trx ORDER BY trx_started LIMIT 5;
```

九成原因是**有人开了事务但很久没提交**（应用里 `BEGIN` 后调了个慢接口）。

### 行锁锁的是索引，不是行

| 情况 | 锁的范围 |
| --- | --- |
| 唯一索引等值命中 | 一行 |
| 普通索引等值 | 索引记录 + 间隙 |
| 无索引条件 | 扫描到的所有行（接近锁表） |

所以"WHERE 条件加索引"既是性能问题，也是并发问题。

### 死锁实验（两个会话）

```sql
-- A
BEGIN; UPDATE t SET v=1 WHERE id=1;
-- B
BEGIN; UPDATE t SET v=2 WHERE id=2;
-- A
UPDATE t SET v=1 WHERE id=2;   -- 等 B
-- B
UPDATE t SET v=2 WHERE id=1;   -- 死锁触发
```

```bash
mysql -e "SHOW ENGINE INNODB STATUS\G" | sed -n '/LATEST DETECTED DEADLOCK/,/---/p'
```

InnoDB 会自动回滚代价小的事务。**正确处理方式是应用层重试**，而不是怪数据库。

### 五条降低锁冲突的写法

1. **事务尽量短**：事务里不要调外部接口、不要等人工。
2. **加锁顺序固定**：多表更新统一按主键升序，能消掉大半死锁。
3. **大范围更新分批**：1000 行一批，批间短暂 sleep。
4. **用乐观锁处理冲突少的场景**：

```sql
UPDATE t SET v = ?, ver = ver + 1 WHERE id = ? AND ver = ?;
-- 返回 0 行 = 被别人改过，重试或报冲突
```

5. **应用层重试**：捕获 1205/1213，退避重试 2–3 次。

### 悲观锁与乐观锁怎么选

| 场景 | 选 |
| --- | --- |
| 扣库存、扣余额，冲突多 | 悲观锁 `SELECT ... FOR UPDATE` |
| 更新用户资料，冲突极少 | 乐观锁版本号 |
| 读多写少且能容忍重试 | 乐观锁 |

余额类场景别用乐观锁循环重试，直接短事务 + 悲观锁更靠谱。

### 本章验证

1. 用两个会话复现一次"锁等待超时"，并用 `data_lock_waits` 找到持有者。
2. 复现一次死锁，读懂 `LATEST DETECTED DEADLOCK` 段。
3. 给一张表加 `ver` 字段，用乐观锁实现一次"安全更新"。

事务与锁的知识点不多，但**每一条都直接对应线上事故**：超卖、丢更新、死锁雪崩。
