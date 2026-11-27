---
title: 常见故障排查：从"连不上"到"越来越慢"
module: 进阶篇
summary: 六类故障的判断路径、错误码对照、锁与死锁、磁盘满与表损坏的处理。
minutes: 50
---

### 六类故障

```
① 连不上（拒绝/超时/认证）
② 慢（查询/锁/IO）
③ 写不进去（只读/磁盘满/锁）
④ 主从异常（延迟/中断）
⑤ 崩溃/表损坏
⑥ 连接数打满
```

### ① 连不上

```bash
mysql -h 10.0.0.1 -u app -p
# ERROR 2003 → 服务没起/端口不通
# ERROR 1045 → 认证失败
# ERROR 1129 → 被 max_connect_errors 封禁
```

**判断顺序**：

```
ping/telnet 3306 → 本机 ss -lntp → 防火墙 → 用户权限（host 匹配）
```

**"root 本地能连、远程不能"** → 用户是 `root@localhost`，不是 `root@%`。

### ② 慢

```sql
SHOW FULL PROCESSLIST;                 -- 谁在跑
SELECT * FROM performance_schema.events_statements_summary_by_digest
ORDER BY SUM_TIMER_WAIT DESC LIMIT 10; -- 谁最耗时
```

**分类**：

```
CPU 高 → 复杂查询/全表扫
IO 高 → 缓冲池不足/大表扫
锁等待 → 看 innodb_lock_waits
```

### 锁与死锁

```sql
SELECT * FROM performance_schema.data_locks;
SELECT * FROM performance_schema.data_lock_waits;
SHOW ENGINE INNODB STATUS\G     -- LATEST DETECTED DEADLOCK
```

**死锁的处理**：

```
① 找出两个事务各持有什么、等什么
② 调整加锁顺序（按固定顺序访问）
③ 缩短事务（不要在事务里做远程调用）
④ 必要时降隔离级别（谨慎）
```

**"死锁了就把隔离级别调成读未提交"** 是掩盖问题。

### ③ 写不进去

```
ERROR 1290 → 只读模式（super_read_only / read_only）
ERROR 1030 → 磁盘空间不足
ERROR 1205 → 锁等待超时
ERROR 1114 → 表满（临时表/磁盘）
```

```sql
SELECT @@read_only, @@super_read_only;
SHOW VARIABLES LIKE 'datadir';   -- 去 df 看这块盘
```

### ④ 主从异常

```sql
SHOW REPLICA STATUS\G
-- Last_IO_Error / Last_SQL_Error
```

**三类**：

```
IO 线程停 → 网络/账号/binlog 被清理
SQL 线程停 → 数据冲突（主键重复）/表不存在
延迟大 → 大事务/单线程/资源不足
```

**"跳过一条错误"** 会让数据永久不一致（除非明确知道这条可跳）。

### ⑤ 崩溃与表损坏

```
现象：启动失败、ERROR 1194/145 表损坏
```

```bash
# 检查
mysqlcheck -u root -p --all-databases
# InnoDB 强制恢复（最后手段，会丢数据）
# my.cnf: innodb_force_recovery=1..6
```

**"innodb_force_recovery=6"** 只能导出数据，不要长期运行。

### ⑥ 连接数打满

```sql
SHOW STATUS LIKE 'Threads_connected';
SHOW STATUS LIKE 'Aborted_connects';
```

**"应用连接泄漏"** 的典型特征：

```
连接数只涨不降 + 大量 Sleep 状态连接
```

**处理**：

```
① 应用侧连接池上限 + 泄漏检测
② 设置 wait_timeout（但别太短）
③ 排查"每次都新建连接"的代码
```

### 错误码速查

| 码 | 含义 |
| --- | --- |
| 1040 | 连接数满 |
| 1045 | 认证失败 |
| 1062 | 主键/唯一冲突 |
| 1205 | 锁等待超时 |
| 1213 | 死锁 |
| 1290 | 只读 |
| 2003 | 连不上服务 |
| 2013 | 连接过程中断开（超时） |

### 检查清单

```
□ 有 processlist 采集（定时快照）
□ 有慢 SQL 排行
□ 有锁等待监控
□ 只读状态有开关记录
□ 磁盘/连接数/复制有监控
□ 有错误码对照表
□ 有"表损坏"应急流程
□ 恢复操作有备份
□ 每次故障记录原因与处置
```
