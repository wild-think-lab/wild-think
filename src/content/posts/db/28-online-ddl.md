---
title: MySQL 在线 DDL：加个索引为什么把库锁住了
description: 三种算法（COPY/INPLACE/INSTANT）的差别、哪些操作会锁表，以及五个"以为不锁其实锁"的操作。
date: 2026-11-27
tags: [数据库, MySQL, DDL]
---

### 三种算法

| 算法 | 行为 | 影响 |
| --- | --- | --- |
| COPY | 建新表 + 拷数据 + 改名 | 全程阻塞写，最慢 |
| INPLACE | 原地重建（不拷到新表） | 多数允许并发 DML，但有元数据锁 |
| INSTANT | 只改元数据 | 秒级，几乎无锁 |

**MySQL 8.0.12+ 支持 INSTANT**（部分操作）。

### 查看会用什么算法

```sql
ALTER TABLE t ADD INDEX idx_a (a), ALGORITHM=INPLACE, LOCK=NONE;
```

**`ALGORITHM` / `LOCK` 是"声明式约束"**：

```
如果不支持，语句直接报错（而不是偷偷降级）
```

**这是最安全的做法**：

```
先在生产用 ALGORITHM=INSTANT 试 → 不支持就显式知道
```

### 各操作的锁情况（8.0）

| 操作 | 算法 | 是否阻塞写 |
| --- | --- | --- |
| 加列（末尾） | INSTANT | 否 |
| 加列（指定位置） | INSTANT（8.0.29+）/ INPLACE | 视版本 |
| 删列 | INSTANT（8.0.29+） | 否 |
| 加索引 | INPLACE | 否（有短暂 MDL） |
| 删索引 | INPLACE | 否 |
| 改列类型 | COPY | 是（全程） |
| 改字符集 | COPY | 是 |
| 加主键 | COPY（多数） | 是 |
| 改列名 | INPLACE | 短锁 |

**"改列类型"是最大的坑**（COPY 全程阻塞写）。

### 五个"以为不锁其实锁"

**① 元数据锁（MDL）被长事务卡住**

```
DDL 需要 MDL 排他锁
→ 有个长事务持有 MDL 共享锁 → DDL 一直等
→ 后面所有请求排队（雪崩）
```

**这是"加个索引把库锁死"最常见的原因**。

排查：

```sql
SELECT * FROM performance_schema.metadata_locks;
SELECT trx_id, trx_state, trx_query, trx_started FROM information_schema.innodb_trx
ORDER BY trx_started LIMIT 5;
```

**处理**：

```
① 先 kill 长事务（或等它结束）
② DDL 设 lock_wait_timeout（如 5 秒，失败就重试）
```

```sql
SET SESSION lock_wait_timeout = 5;
```

**② 分区表操作**

```
REORGANIZE PARTITION 往往是 COPY（非常慢）
```

**③ 外键约束**

```
加外键 / 改被引用的列 → 需要校验全表 → 慢且锁
```

**④ 生成列 / 改默认值（老版本）**

```
5.7 下改列默认值 = 重建表
8.0 改默认值 = INSTANT
```

**⑤ 大表加索引的"隐性成本"**

```
INPLACE 也要"扫表 + 排序 + 写新索引页"
→ IO 与 CPU 峰值，主从延迟暴涨
```

### 大表 DDL 的正确做法

```
① 在从库先做（验证耗时与影响）
② 主库做时避开业务高峰
③ 用 gh-ost / pt-online-schema-change（第三方工具，可分片/可暂停）
④ 加索引前评估"是否真需要"
```

**gh-ost 的原理**：

```
影子表 + binlog 同步 → 追上后原子 rename
→ 对业务影响小，可控
```

```bash
gh-ost --host=... --database=db --table=t \
  --alter "ADD INDEX idx_a (a)" \
  --max-load "Threads_running=30" --critical-load "Threads_running=60" \
  --allow-on-master
```

### 主从延迟的处理

```
DDL 在从库执行 → 从库回放慢 → 延迟增大
→ 若从库在提供服务，读请求会看到"旧结构"
```

**"DDL 期间从库延迟 300 秒"** 很常见，要提前通知或摘流量。

### 一个"上线 DDL"的检查表

```sql
-- 1) 看看会用什么算法
ALTER TABLE t ADD COLUMN c INT, ALGORITHM=INSTANT;

-- 2) 看表大小
SELECT table_rows, data_length/1024/1024 AS mb FROM information_schema.tables
WHERE table_schema='db' AND table_name='t';

-- 3) 看有没有长事务
SELECT COUNT(*) FROM information_schema.innodb_trx;

-- 4) 设锁等待超时（避免雪崩）
SET SESSION lock_wait_timeout = 5;
```

### 检查清单

```
□ 明确每个 DDL 的算法（INSTANT/INPLACE/COPY）
□ 用 ALGORITHM/LOCK 显式声明（不偷偷降级）
□ 先查长事务（避免 MDL 卡死）
□ 设 lock_wait_timeout（失败可重试）
□ 大表用 gh-ost/pt-osc
□ 先在从库验证
□ 避开业务高峰
□ 关注从库延迟
□ 有回滚方案（DDL 多数不可逆，要提前想）
□ 所有 DDL 走变更流程
```
