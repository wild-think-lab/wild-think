---
title: MySQL 主从复制：延迟、断流与"数据看起来不一样"
description: 复制的三个线程、延迟的五个来源、断流的排查路径，以及五个"主从数据不一致"的原因。
date: 2026-08-18
tags: [数据库, MySQL, 复制]
---

### 三个线程

```
主库：Binlog Dump（发送 binlog）
从库：IO Thread（拉取）→ relay log → SQL Thread（回放）
```

**"两个状态都要看"**：

```sql
SHOW SLAVE STATUS\G
-- Slave_IO_Running / Slave_SQL_Running
-- Seconds_Behind_Master
-- Relay_Log_Pos / Exec_Master_Log_Pos
```

**"IO 是 Yes、SQL 是 No"** → 回放报错（数据问题/DDL/主键冲突）。

### 延迟的五个来源

**① 大事务**

```
一个事务改 100 万行 → 从库要回放很久
→ 拆小批（每批 1000–5000 行）
```

**② 单线程回放**

```
MySQL 5.7+ 支持并行复制（按库/按组提交）
需要开启：slave_parallel_workers + slave_parallel_type=LOGICAL_CLOCK
```

**③ 从库硬件弱于主库**

```
IO/CPU 跟不上 → 延迟累积
```

**④ 从库承担了重读**

```
读请求太多 → SQL 线程抢不到资源
```

**⑤ DDL**

```
大表 DDL 在主库 10 分钟 → 从库回放也可能很久
```

### 判断"延迟是否在扩大"

```sql
-- 连续采样对比
SHOW SLAVE STATUS\G
```

**"Seconds_Behind_Master 在涨"** → 回放跟不上（不是抖动）。

**注意**：

```
Seconds_Behind_Master 可能为 0 但实际有延迟（GTID 未对齐/时钟）
→ 用 pt-heartbeat 更准确
```

### 断流的排查路径

```
1) Slave_IO_Running: No
   → 看 Last_IO_Error（认证/网络/binlog 被清理）

2) Slave_SQL_Running: No
   → 看 Last_SQL_Error（主键冲突/表不存在/DDL 不一致）

3) 位点/GTID 对不上
   → 确认 master_log_file/pos 或 gtid 集合
```

**"binlog 被清理导致从库追不上"** 是常见灾难：

```
主库 expire_logs_days 太小 + 从库断了几天 → 无法追平 → 只能重做从库
```

### 五个"主从数据不一致"

**① 从库被写入**

```
read_only=1 未开（或有 SUPER 用户绕过）
→ 从库被应用误写 → 数据分叉
```

**② 非确定性 SQL**

```
NOW()/RAND()/UUID() 在 STATEMENT 格式下主从不一致
→ 用 ROW 格式
```

**③ 复制过滤规则**

```
binlog_do_db / replicate_ignore_db 配错 → 少同步
```

**④ 主库崩溃时的半同步未生效**

```
半同步超时降级为异步 → 已提交但未传的 binlog 丢失
```

**⑤ 手工修复**

```
在主库直接改数据（未走 SQL）→ binlog 有记录，但某些操作漏了
```

**"从库只读"必须开**：

```sql
SET GLOBAL read_only = ON;
SET GLOBAL super_read_only = ON;   -- 连 SUPER 也禁
```

### 校验一致性

```bash
# pt-table-checksum（在线校验）
pt-table-checksum --host=master --databases=db --replicate=percona.checksums
# 有差异则用 pt-table-sync 修复（谨慎，先 dry-run）
pt-table-sync --dry-run --print h=master,D=db,t=orders h=slave
```

**"定期校验一次"** 比"出问题再查"好。

### 复制架构的几种演进

```
① 一主一从（最简单）
② 一主多从（读扩展）
③ 级联（从库再挂从库，减轻主库压力）
④ 双主（互为主从，需防循环/冲突）
⑤ 组复制（MGR，多主/自动故障转移）
```

**"双主"** 的风险：

```
两端同时写同一行 → 冲突（需要应用层规避）
```

### 检查清单

```
□ 从库 read_only + super_read_only
□ 用 ROW 格式
□ 大事务拆批
□ 并行复制已开启
□ Seconds_Behind_Master 有监控
□ 用 pt-heartbeat 看真实延迟
□ binlog 保留足够（覆盖最长断连时间）
□ 有半同步（关键业务）
□ 定期 pt-table-checksum 校验
□ 有"重做从库"的 runbook（含耗时估算）
```
