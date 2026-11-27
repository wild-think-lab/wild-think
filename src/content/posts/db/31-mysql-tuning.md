---
title: MySQL 参数调优：八个参数决定一半性能
description: buffer pool、连接数、redo/undo、临时表与慢查询，以及五个"调了参数更慢"的原因。
date: 2026-11-27
tags: [数据库, MySQL, 调优]
---

### 先看"是不是内存问题"

```sql
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool%';
```

```
Innodb_buffer_pool_read_requests   ：请求次数
Innodb_buffer_pool_reads           ：物理读次数
命中率 = 1 - reads / read_requests
```

**"命中率 < 95%"** → buffer pool 不够（或热数据太多）。

### ① innodb_buffer_pool_size

```
建议：物理内存的 50%–70%（专用 DB 服务器）
例：32G 内存 → 20G
```

```conf
innodb_buffer_pool_size = 20G
innodb_buffer_pool_instances = 8
```

**`instances`** 减少锁竞争（每实例 ≥ 1G）。

**"设置过大导致系统 OOM"** → 留出系统与应用内存。

### ② max_connections

```sql
SHOW STATUS LIKE 'Threads_connected';
SHOW STATUS LIKE 'Max_used_connections';
SHOW VARIABLES LIKE 'max_connections';
```

**判据**：

```
Max_used_connections / max_connections > 80% → 不足
但"调大连接数"往往是治标（连接泄漏/慢查询才是根因）
```

**"连接数打满"** → 先查"是否有慢查询占着连接"。

### ③ redo log（8.0 动态）

```conf
innodb_log_file_size = 2G          # 8.0 用 innodb_redo_log_capacity
innodb_redo_log_capacity = 8G
innodb_flush_log_at_trx_commit = 1 # 最安全
```

**权衡**：

```
=1 ：每次提交刷盘（安全，稍慢）
=2 ：每秒刷（可能丢 1 秒事务）
=0 ：交给 OS（最快最不安全）
```

**"redo 太小"** → 频繁 checkpoint → 写入抖动。

### ④ undo 与 purge

```conf
innodb_max_undo_log_size = 4G
innodb_purge_threads = 4
```

**"undo 表空间一直涨"** → 有长事务（purge 追不上）。

### ⑤ 临时表与排序

```sql
SHOW STATUS LIKE 'Created_tmp%';
```

```
Created_tmp_disk_tables 高 → 排序/分组溢出到磁盘
```

```conf
tmp_table_size = 64M
max_heap_table_size = 64M
```

**"filesort 很多"** → 缺索引或排序字段设计问题（不是参数问题）。

### ⑥ 慢查询

```conf
slow_query_log = ON
long_query_time = 0.5
log_queries_not_using_indexes = OFF   # 生产建议关（噪音大）
```

**"开了 not_using_indexes"** → 日志爆炸（很多小表本来就不需要索引）。

### ⑦ InnoDB 并发

```conf
innodb_thread_concurrency = 0        # 0 = 不限制（推荐让 InnoDB 自己管）
innodb_read_io_threads = 8
innodb_write_io_threads = 8
```

**"设了很小的 thread_concurrency"** → 并发被压死（老经验害人）。

### ⑧ 刷脏页

```conf
innodb_io_capacity = 2000            # SSD
innodb_io_capacity_max = 4000
innodb_flush_neighbors = 0           # SSD 建议 0
```

**"HDD 上 flush_neighbors=0"** 会降低效率（SSD 才建议 0）。

### 五个"调了参数更慢"

**① buffer pool 超过物理内存**

```
触发 swap/OOM → 整体性能崩
```

**② 把 flush_log_at_trx_commit 改成 0**

```
写入快了，但"掉电丢数据"（且崩溃恢复变慢）
```

**③ max_connections 调到 5000**

```
线程爆炸 → 上下文切换打满 CPU
```

**④ 调大 tmp_table_size 但内存不足**

```
每个连接都占 → 总内存爆
```

**⑤ 照抄"网上最佳实践"**

```
硬件/负载完全不同 → 参数互相打架
```

**"一次只改一个参数 + 压测对比"** 是唯一可靠的方法。

### 一个"先测再调"的流程

```
1) 记录基线（QPS/延迟/慢查询数/命中率）
2) 找瓶颈（IO/CPU/锁/连接）
3) 改一个参数
4) 压测/观察 24h
5) 有改善则保留，否则回滚
6) 记录结论（哪个参数、什么负载、效果多少）
```

### 检查清单

```
□ buffer pool 50–70% 内存 + instances ≥ 1G
□ 命中率 > 95%
□ max_connections 合理（不靠调大解决泄漏）
□ redo 容量足够（避免频繁 checkpoint）
□ undo 无长事务堆积
□ 临时表不溢盘（或确认是设计问题）
□ 慢查询日志开着（阈值合理）
□ io_capacity 与磁盘匹配
□ 一次只改一个参数并压测
□ 有参数变更记录
```
