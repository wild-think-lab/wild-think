---
title: PostgreSQL 的 vacuum 与膨胀：为什么表越用越大
description: MVCC 与死元组、autovacuum 调参、膨胀检测 SQL，以及五个"vacuum full 把库锁死"的原因。
date: 2026-11-27
tags: [数据库, PostgreSQL, 运维]
---

### 为什么 PG 会"越用越大"

```
UPDATE = 插入新版本 + 标记旧版本为死元组
DELETE = 只标记，不物理删除
→ 死元组占空间，直到 vacuum 回收
```

**"update 多的表"** 膨胀最严重（不是数据变多了，是死元组堆着）。

### 看死元组与膨胀

```sql
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup::numeric / greatest(n_live_tup,1) * 100, 2) AS dead_pct,
       last_autovacuum, last_vacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;
```

**判据**：

```
dead_pct > 20% 且表较大 → 需要关注
last_autovacuum 很久以前 → autovacuum 没跟上
```

**估算膨胀**：

```sql
SELECT schemaname, relname,
       pg_size_pretty(pg_total_relation_size(relid)) AS total,
       pg_size_pretty(pg_relation_size(relid)) AS heap
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;
```

### autovacuum 调参

```conf
autovacuum = on
autovacuum_max_workers = 6
autovacuum_naptime = 20s
autovacuum_vacuum_scale_factor = 0.05     # 默认 0.2 太保守
autovacuum_vacuum_threshold = 100
autovacuum_vacuum_cost_limit = 2000       # 默认 200 太慢
autovacuum_vacuum_cost_delay = 2ms
```

**核心**：

```
scale_factor 0.2 → 表有 20% 死元组才触发（大表永远等不到）
→ 大表要单表设置（表级 reloptions）
```

```sql
ALTER TABLE big_t SET (autovacuum_vacuum_scale_factor = 0.02,
                       autovacuum_vacuum_cost_limit = 5000);
```

### 手工 VACUUM 与 VACUUM FULL

```sql
VACUUM (VERBOSE) t;          -- 只回收空间给"未来复用"，不缩文件
VACUUM FULL t;               -- 重写表，真正缩小文件（锁表！）
```

**关键差别**：

```
VACUUM      ：并发友好，但"文件不缩"
VACUUM FULL ：缩文件，但"AccessExclusiveLock"（全表不可读写）
```

**"用 VACUUM FULL 解决磁盘满"** 是常见但危险的做法。

### 五个"vacuum full 把库锁死"

**① 大表 VACUUM FULL 耗时数小时**

```
期间表完全不可用 → 业务超时
```

**替代**：`pg_repack`（在线重写，只短暂锁）

```bash
pg_repack -d db -t big_t
```

**② 磁盘空间不够**

```
VACUUM FULL 需要"原表 + 新表"两份空间
→ 空间不足时直接失败
```

**③ 复制槽/长事务阻止回收**

```sql
SELECT * FROM pg_replication_slots WHERE active = false;
SELECT pid, now() - xact_start AS dur, query FROM pg_stat_activity
WHERE xact_start IS NOT NULL ORDER BY dur DESC LIMIT 5;
```

**"有个长事务开着"** → 死元组永远回收不了。

**④ 没有监控 autovacuum 进度**

```sql
SELECT relname, phase, heap_blks_total, heap_blks_scanned
FROM pg_stat_progress_vacuum;
```

**⑤ 误以为"VACUUM 能解决所有膨胀"**

```
索引膨胀要 REINDEX
表膨胀要 vacuum（或 repack）
```

### 索引膨胀

```sql
REINDEX INDEX CONCURRENTLY idx_name;    -- 11+ 支持并发
```

**"索引比表还大"** → 单独 REINDEX。

### 三个"能提前发现"的信号

```
① n_dead_tup 持续增长（autovacuum 没跟上）
② 表大小增长远快于行数增长（膨胀）
③ 事务 ID 年龄逼近 20 亿（wraparound 风险）
```

```sql
SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;
```

**"xid 年龄 > 10 亿"** 必须立即处理（否则库变只读）。

### 检查清单

```
□ 监控死元组比例
□ autovacuum scale_factor 对大表下调
□ autovacuum cost_limit 提高（跟得上写入）
□ 没有长事务/失效复制槽
□ 用 pg_repack 替代 VACUUM FULL（大表）
□ 索引膨胀单独 REINDEX CONCURRENTLY
□ 监控 xid 年龄（< 10 亿）
□ 磁盘有"重写空间"余量
□ 有膨胀趋势看板
```
