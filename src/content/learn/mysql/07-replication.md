---
title: 复制与高可用：主从、延迟与切换
module: 熟练篇
summary: 主从原理与搭建、复制延迟的五个原因、半同步、以及"切换时到底该做什么"。
minutes: 50
---

### 复制在复制什么

```
① 主库写 binlog（记录变更）
② 从库 IO 线程拉 binlog → 写 relay log
③ 从库 SQL 线程重放 relay log
```

**"Seconds_Behind_Master"** 测的是"重放落后多久"，不等于"数据延迟"。

### 搭建（异步复制最小步骤）

```sql
-- 主库
CREATE USER 'repl'@'%' IDENTIFIED WITH mysql_native_password BY 'xxx';
GRANT REPLICATION SLAVE ON *.* TO 'repl'@'%';
-- my.cnf
-- server-id=1, log_bin=ON, binlog_format=ROW, gtid_mode=ON, enforce_gtid_consistency=ON

-- 从库
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST='10.0.0.1', SOURCE_USER='repl', SOURCE_PASSWORD='xxx',
  SOURCE_AUTO_POSITION=1;
START REPLICA;
SHOW REPLICA STATUS\G
```

**GTID 模式**比"记 pos 位点"省事得多（不用记 `binlog file + pos`）。

### 复制延迟的五个原因

```
① 大事务（一次更新百万行）
② 单线程重放（老版本 SQL 线程串行）
③ 从库资源不足（磁盘慢/CPU 满）
④ 从库还在跑重查询（抢资源）
⑤ 网络抖动（IO 线程拉取慢）
```

**判据**：

```sql
SHOW REPLICA STATUS\G
-- 看 Seconds_Behind_Source / Relay_Log_Space 增长
```

**"延迟只在业务高峰出现"** → 多线程复制没开或并行度不够：

```conf
replica_parallel_workers = 8
replica_parallel_type = LOGICAL_CLOCK
```

### 半同步（牺牲一点性能换数据）

```sql
INSTALL PLUGIN rpl_semi_sync_source SONAME 'semisync_source.so';
SET GLOBAL rpl_semi_sync_source_enabled = 1;
SET GLOBAL rpl_semi_sync_source_timeout = 30000;
```

**语义**：

```
至少一个从库确认收到 binlog 才返回成功
超时 → 退化为异步（要注意这个"退化"）
```

### 高可用切换：三件事

```
① 确认主库真的不可用（不是网络抖动）
② 选一个新主（延迟最小、数据最全）
③ 让其他从库指向新主 + 应用切换
```

**"直接切"** 的风险：

```
旧主其实活着 → 双主写入 → 数据分叉
```

**避免脑裂**：

```
① 用仲裁（多数派确认主库不可用）
② 用 fencing（旧主被隔离/停止）
③ 有 GTID 时按 GTID 补齐
```

### 手工切换（演练用）

```sql
-- 在候选从库
STOP REPLICA;
RESET REPLICA ALL;
SET GLOBAL read_only = OFF;

-- 在其他从库
CHANGE REPLICATION SOURCE TO SOURCE_HOST='new-master', SOURCE_AUTO_POSITION=1;
START REPLICA;
```

**演练必做**：切换后"应用能否写"、"旧主恢复后怎么处理（作为从库接回）"。

### 五个"复制看着正常其实有问题"

**① 过滤规则不一致**

```
主库不写某库，从库却配置了 replicate-do-db → 数据不一致
```

**② 时区/字符集不同**

```
时间字段差 8 小时
```

**③ 从库被写入过**

```
read_only 没开 → 数据分叉
```

**④ 延迟只看秒数**

```
Seconds_Behind=0 但 relay log 还在积压（新版本语义变化）
```

**⑤ 备份在从库跑**

```
备份期间从库延迟升高
```

### 检查清单

```
□ GTID 开启（或明确位点管理）
□ binlog_format=ROW
□ 从库 read_only
□ 多线程复制
□ 半同步（按业务需要）
□ 延迟有监控（不只秒数）
□ 有"主库故障"切换预案
□ 有 fencing/仲裁防脑裂
□ 切换演练过（含旧主回归）
□ 过滤规则严格一致
```
