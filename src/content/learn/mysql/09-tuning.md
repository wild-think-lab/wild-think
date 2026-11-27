---
title: 参数调优：先看瓶颈，再动参数
module: 进阶篇
summary: 四条最常见的参数、InnoDB 缓冲池的比例、连接数与线程、以及五个"调完更慢"的原因。
minutes: 45
---

### 调参前必须做的两件事

```
① 找到瓶颈（CPU/IO/内存/锁/网络）
② 有基线（调之前是多少，调之后能对比）
```

**"网上抄一份 my.cnf"** 是把别人的瓶颈当成自己的。

### 四条最值得先看

```conf
innodb_buffer_pool_size = 60% ~ 70% 物理内存
innodb_log_file_size   = 1G ~ 2G（大事务多则更大）
innodb_flush_log_at_trx_commit = 1   # 数据安全（=2 更快但不安全）
max_connections = 按实际并发（不是越大越好）
```

**"buffer pool 越大越好"** → 超过物理内存会 swap，反而更慢。

### 缓冲池命中率

```sql
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read%';
```

```
Innodb_buffer_pool_read_requests  逻辑读
Innodb_buffer_pool_reads          物理读
命中率 = 1 - reads/read_requests
```

**判据**：命中率 < 95% 且物理读在涨 → 缓冲池不足或数据集太大。

### 连接与线程

```sql
SHOW STATUS LIKE 'Threads_connected';
SHOW STATUS LIKE 'Max_used_connections';
SHOW VARIABLES LIKE 'max_connections';
```

**"把 max_connections 调到 2000"** 会带来：

```
每个连接占内存（排序缓冲/连接缓冲）× 2000
→ 内存爆、上下文切换多
```

**正确做法**：应用侧用连接池，池大小 = 并发 × (1 + 余量)。

### 慢查询日志

```conf
slow_query_log = 1
long_query_time = 0.5
log_queries_not_using_indexes = 0   # 开了会很多噪音
```

```bash
mysqldumpslow -s t -t 20 slow.log
```

### 五个"调完更慢"

**① 缓冲池过大 → swap**

```
物理内存 16G，buffer pool 设 14G → 系统其他进程被换出
```

**② 连接数暴涨 → 内存与锁竞争**

```
max_connections 不是性能开关
```

**③ 关掉 doublewrite → 崩溃后页损坏**

```
短期快了，故障时无法恢复
```

**④ innodb_flush_log_at_trx_commit=0**

```
快，但断电丢 1 秒数据（金融场景不可接受）
```

**⑤ 关掉自适应哈希 / 改排序缓冲**

```
没针对瓶颈的调整，往往只是把问题挪个位置
```

### 一个"保守"的调优顺序

```
1) 先修 SQL 与索引（收益最大）
2) 再调 buffer pool（内存换 IO）
3) 再调日志/刷盘（权衡安全）
4) 最后考虑连接与线程
```

**"先调参数不改 SQL"** 是本末倒置。

### 检查清单

```
□ 有调优前的基线
□ 瓶颈已定位（不是猜）
□ buffer pool 比例合理（不超内存）
□ 命中率 > 95%（或明确接受）
□ 连接池在应用侧限制
□ 慢日志开启且阈值合理
□ 刷盘策略与业务容忍度匹配
□ 每次只改 1–2 个参数
□ 有压测对比
□ 变更记录在案
```
