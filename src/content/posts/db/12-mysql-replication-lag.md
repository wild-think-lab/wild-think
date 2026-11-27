---
title: MySQL 主从延迟：为什么从库总是慢半拍
description: 延迟的四个来源（大事务、单线程回放、锁等待、网络）、Seconds_Behind_Master 会骗人、并行复制怎么开、以及"读从库读到旧数据"的应对。
date: 2023-07-22
tags: [MySQL, 主从复制, 延迟, 数据库]
---

### 先看几个数

```sql
SHOW SLAVE STATUS\G
```

关键字段：

```
Slave_IO_Running: Yes          拉 binlog 的线程（网络）
Slave_SQL_Running: Yes         回放 binlog 的线程（执行）
Seconds_Behind_Master: 0       落后多少秒（会骗人）
Relay_Log_Space: ...           中继日志大小（积压量）
```

**`Seconds_Behind_Master` 的三个陷阱**：

1. 它算的是"最后回放的事件时间 vs 当前时间"，**大事务回放中会一直显示增大**，然后突然归零。
2. IO 线程挂了、SQL 线程正常时，它可能是 0 或 NULL，看起来"没问题"。
3. 主从时钟不同步时，数值完全不可信。

更可靠的指标：

```sql
-- 用 GTID 对比（需要 GTID 模式）
SELECT @@global.gtid_executed;          -- 从库
-- 与主库对比，差得越多越落后

-- 或对比 binlog 位置
SHOW MASTER STATUS;                     -- 主库
SHOW SLAVE STATUS\G                     -- 从库的 Read_Master_Log_Pos / Exec_Master_Log_Pos
```

**`Exec_Master_Log_Pos` 与 `Read_Master_Log_Pos` 的差** = 中继日志积压量，这才是真正的"回放跟不上"。

### 四个来源

**① 大事务**

一个事务改了 50 万行，从库必须"一次性"回放完才能继续。这期间延迟持续增长。

对策：

- 拆批（每批 1000–5000 行）。
- 避免 `DELETE FROM t WHERE ...` 一次删百万行。

```sql
-- 分批删除
DELETE FROM logs WHERE created_at < '2026-01-01' LIMIT 5000;
-- 循环执行直到删完
```

**② 单线程回放（老版本）**

MySQL 5.6 之前从库只有单线程回放，主库多核并发写，从库一核回放必落后。

开启并行复制（5.7+）：

```ini
slave_parallel_type = LOGICAL_CLOCK
slave_parallel_workers = 8          # 通常设为 CPU 核数的 1/2~1
slave_preserve_commit_order = 1     # 保证提交顺序，避免数据错乱
```

检查是否生效：

```sql
SHOW PROCESSLIST;   -- 应看到多个 "Waiting for ..." 的 worker 线程
```

**③ 锁等待**

从库上有长查询（读流量）持锁，回放线程等锁。

```sql
-- 从库上看锁等待
SELECT * FROM performance_schema.data_lock_waits;
```

对策：读写分离时，把重查询（大报表）走独立从库，不要和回放抢同一台。

**④ 网络与磁盘**

- 跨机房复制，带宽不足 → `Relay_Log_Space` 持续增长。
- 从库磁盘慢（机械盘）→ 回放跟不上。

```bash
# 看从库 IO
iostat -x 1 5
```

### 半同步：用延迟换可靠性

```ini
# 主库
plugin_load_add = 'semisync_master.so'
rpl_semi_sync_master_enabled = 1
rpl_semi_sync_master_timeout = 1000     # 毫秒，超时降级为异步
```

半同步意味着"至少一个从库确认收到"才返回成功。代价是**每次写多一个 RTT**。

判断：**数据不能丢（金融/订单）→ 半同步；能接受少量丢失（日志/统计）→ 异步**。

### "读从库读到旧数据"

这是延迟导致的业务问题，三种应对：

**① 关键读走主库**

```python
def get_order(order_id):
    # 刚创建/刚修改的数据，强制读主
    return db_master.query(...)
```

**② 写后读（read-your-writes）**

用户写完立刻读，用小窗口粘住主库（如 3 秒内该用户读主）。

```python
if time.time() - last_write_ts[user_id] < 3:
    conn = master
else:
    conn = replica
```

**③ 用 GTID 判断是否追平**

```python
# 写时记录 GTID，读从库前检查是否已执行
def read_from_replica(expected_gtid):
    if replica.gtid_executed >= expected_gtid:
        return replica.query(...)
    return master.query(...)
```

方案 ③ 最精确，但要应用层配合。

### 监控项

```sql
-- 延迟（用位置差更可靠）
SELECT
  (SELECT Read_Master_Log_Pos FROM ...) -
  (SELECT Exec_Master_Log_Pos FROM ...) AS backlog_bytes;
```

告警阈值：

| 指标 | 告警 |
| --- | --- |
| 延迟（秒） | > 10s 警告，> 30s 严重 |
| 中继日志积压 | 持续增长 |
| `Slave_SQL_Running` | 非 Yes 立即告警 |
| 主从 GTID 差 | 持续扩大 |

### 一个真实的排查过程

现象：从库延迟从 0 涨到 300 秒，持续 20 分钟后恢复。

排查：

1. `SHOW SLAVE STATUS` → `Slave_SQL_Running: Yes`，`Seconds_Behind_Master: 300`，`Relay_Log_Space` 很大。
2. 看从库 `SHOW PROCESSLIST` → 一个 `DELETE` 语句在跑（回放大事务）。
3. 主库 binlog 里找对应事件 → 一个 `DELETE FROM sessions WHERE ...` 删了 800 万行。

结论：单条大 DELETE 导致回放长时间阻塞。

改进：

1. 业务侧改成分批删除。
2. 从库 `slave_parallel_workers` 从 0 调到 8。
3. 加"单事务行数"监控告警（binlog 里 `Rows_query` 或解析 binlog 统计）。

### 检查清单

```
□ 并行复制已开启（LOGICAL_CLOCK + workers ≥ 4）
□ 业务侧无超大事务（单事务 < 1 万行）
□ 从库不与重查询混用
□ 延迟用"位置差"监控，不只依赖 Seconds_Behind_Master
□ 关键读有"写后读主库"策略
□ IO/SQL 线程任一异常立即告警
```
