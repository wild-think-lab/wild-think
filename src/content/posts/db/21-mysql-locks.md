---
title: MySQL 锁：为什么"只查不改"也会死锁
description: 间隙锁、临键锁、意向锁的作用范围，隔离级别怎么影响加锁，以及六种"看起来没问题"的死锁场景。
date: 2025-07-19
tags: [MySQL, 数据库, 锁, 并发]
---

### 先把锁的分类说清

```
按粒度：表锁 / 行锁 / 页锁（InnoDB 基本是行锁）
按模式：共享锁（S）/ 排他锁（X）
按用途：记录锁（Record）/ 间隙锁（Gap）/ 临键锁（Next-Key）/ 插入意向锁
按实现：意向锁（IS/IX）是"表级标志"，用于快速判断表内是否有行锁
```

**关键概念**：

```
间隙锁（Gap Lock）：锁住"记录之间的空隙"，防止插入
临键锁（Next-Key）：记录锁 + 间隙锁（左开右闭区间），RR 默认
```

**这就是"只查不改也会死锁"的根源**：`SELECT ... FOR UPDATE` 在 RR 下会加临键锁。

### 实验：只读查询引发死锁

```sql
-- 表结构
CREATE TABLE t (id INT PRIMARY KEY, v INT) ENGINE=InnoDB;
INSERT INTO t VALUES (1,10),(5,20),(10,30);

-- 会话 A
BEGIN;
SELECT * FROM t WHERE id = 5 FOR UPDATE;   -- 锁住 (1,5] 这段（临键锁）

-- 会话 B
BEGIN;
SELECT * FROM t WHERE id = 7 FOR UPDATE;   -- 想插在 (5,10) 之间，被 A 的间隙锁挡住
```

**注意**：`id=7` 这行根本不存在，但 B 依然被阻塞 —— 因为 **A 锁住了"5 到 10 之间的间隙"**。

**这就是"查不存在的行也会锁"**。

### 隔离级别如何改变加锁

| 隔离级别 | 普通 SELECT | `SELECT FOR UPDATE` |
| --- | --- | --- |
| READ UNCOMMITTED | 不加锁 | 加锁 |
| READ COMMITTED | 不加锁（MVCC 快照） | 只锁存在的记录（无间隙锁） |
| REPEATABLE READ | 不加锁（MVCC 快照） | **加临键锁（含间隙）** |
| SERIALIZABLE | 加共享锁 | 加锁 |

**RR 与 RC 的最大区别就在这里**：

```
RC  ：SELECT FOR UPDATE 不加间隙锁 → 死锁概率低
RR  ：加间隙锁 → 防幻读，但死锁概率高
```

**很多团队把默认改成 RC**，就是为了降低死锁。

### 六种"看起来没问题"的死锁

**① 两个事务交叉更新**

```sql
-- A: UPDATE t SET v=1 WHERE id=1;  然后 UPDATE t SET v=2 WHERE id=2;
-- B: UPDATE t SET v=3 WHERE id=2;  然后 UPDATE t SET v=4 WHERE id=1;
```

**经典 AB-BA 死锁**。修法：**统一更新顺序**（按 id 升序）。

**② 唯一索引与非唯一索引混合**

```sql
-- A: 用唯一索引更新
UPDATE t SET v=1 WHERE uk = 'x';
-- B: 用非唯一索引更新同一行
UPDATE t SET v=2 WHERE normal_idx = 'y';
```

**不同索引路径 → 加锁顺序不同 → 交叉死锁**。

**③ 间隙锁 + 插入**

```sql
-- A: SELECT * FROM t WHERE id BETWEEN 1 AND 10 FOR UPDATE;   -- 锁住大区间
-- B: INSERT INTO t VALUES (3, ...);                          -- 插入意向锁被挡
-- A 又要插 3 → 与 B 互等
```

**④ 外键**

```
更新父表 → 需要锁子表的相关行 → 与另一事务反向操作互等
```

**外键是死锁的常见放大器**。

**⑤ 大批量 UPDATE 不分批**

```sql
UPDATE t SET flag=1 WHERE created_at < '2026-01-01';  -- 扫 100 万行，锁 100 万行
```

**长事务 + 大量行锁 → 阻塞一切**。修法：分批（每次 1000 行）。

**⑥ `REPLACE INTO` / `INSERT ... ON DUPLICATE KEY`**

```
先加插入意向锁，冲突后再升级为排他锁 → 过程中的锁顺序不固定
```

### 怎么查死锁

```sql
-- 最近一次死锁
SHOW ENGINE INNODB STATUS\G
-- 找 "LATEST DETECTED DEADLOCK" 段
```

**这段信息非常详细**：

```
① 两个事务各持有什么锁
② 各自在等什么锁
③ 涉及哪张表、哪个索引、哪一行
```

**开启死锁日志**：

```sql
SET GLOBAL innodb_print_all_deadlocks = ON;
-- 所有死锁写入 error log
```

**监控**：

```sql
SHOW STATUS LIKE 'Innodb_deadlocks';   -- 累计死锁次数
```

**死锁 ≠ 错误**：InnoDB 会自动回滚其中一个事务，业务侧看到的是 `Deadlock found when trying to get lock`。

**要关注的是"频率"**：偶尔一次可接受，持续出现必须修。

### 减少死锁的七个手段

```
① 事务尽量短（不做网络调用、不做大计算）
② 统一加锁顺序（按主键/固定字段排序）
③ 用主键或唯一索引定位（避免走非唯一索引）
④ 减少间隙锁：能接受就用 RC 隔离级别
⑤ 大更新分批（每批 500–1000 行 + 短暂 sleep）
⑥ 减少外键（或用应用层保证一致性）
⑦ 重试机制（捕获死锁后重试 2–3 次）
```

**重试的正确写法**：

```
捕获错误码 1213（死锁）/ 1205（锁等待超时）
→ 随机退避 50–200ms 后重试
→ 最多 3 次
```

**不要无限重试**，否则会放大拥塞。

### 锁等待超时

```sql
SHOW VARIABLES LIKE 'innodb_lock_wait_timeout';   -- 默认 50 秒
```

**50 秒太长**：用户早就超时了，连接还占着。

**建议**：

```
OLTP 业务：5–10 秒
批量任务：单独会话临时调大
```

```sql
SET SESSION innodb_lock_wait_timeout = 600;   -- 仅当前会话
```

### 查看当前锁等待

```sql
-- MySQL 8.0
SELECT * FROM performance_schema.data_locks;
SELECT * FROM performance_schema.data_lock_waits;

-- 谁在等谁
SELECT
  r.trx_id waiting_trx,
  r.trx_mysql_thread_id waiting_thread,
  b.trx_id blocking_trx,
  b.trx_mysql_thread_id blocking_thread
FROM performance_schema.data_lock_waits w
JOIN information_schema.innodb_trx b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
JOIN information_schema.innodb_trx r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID;
```

**这比 `SHOW PROCESSLIST` 精确得多**（后者只看到 `Locked` 状态，看不到谁锁的）。

### 检查清单

```
□ 事务尽量短（无网络/无长计算）
□ 统一加锁顺序
□ 用主键/唯一索引定位更新
□ 评估隔离级别（RR 的间隙锁代价）
□ 大更新分批
□ 谨慎使用外键
□ 业务侧有死锁重试（限次 + 退避）
□ lock_wait_timeout 调到合理值
□ 开 innodb_print_all_deadlocks
□ 监控 Innodb_deadlocks 频率
□ 会用 data_lock_waits 查锁等待链
```
