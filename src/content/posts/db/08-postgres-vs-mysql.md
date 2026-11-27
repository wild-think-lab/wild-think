---
title: PostgreSQL 与 MySQL 怎么选：不看热度看场景
description: 两者在事务、索引、复制、JSON、扩展性上的真实差别，八个场景对号入座，迁移时要付的代价，以及"两个都上"的常见架构。
date: 2022-07-09
tags: [PostgreSQL, MySQL, 数据库, 选型]
---

### 一句话结论

**要复杂查询、强一致、丰富类型 → PostgreSQL；要简单读写、生态成熟、运维人力多 → MySQL。**

但这句话太粗，下面拆开看。

### 五个真正的差别

**① 事务与并发控制**

| | MySQL（InnoDB） | PostgreSQL |
| --- | --- | --- |
| 隔离级别默认 | 可重复读（RR） | 读已提交（RC） |
| 实现 | MVCC + 间隙锁 | MVCC，无间隙锁（用 SSI 做可串行化） |
| 幻读 | RR 下靠间隙锁避免 | RC 下不避免，需要 SSI |
| 长事务影响 | 会阻塞、undo 膨胀 | 会导致表膨胀（需要 vacuum） |

PostgreSQL 没有间隙锁，写入并发更好，但代价是**长事务会让表膨胀**（dead tuple 堆积），必须调 autovacuum。

**② 索引**

- MySQL：B+ 树、聚簇索引（主键即数据）、全文索引（有限）。
- PostgreSQL：B 树、GiST、GIN、BRIN、Hash，支持**表达式索引**与**部分索引**。

```sql
-- PostgreSQL 独有的实用能力
CREATE INDEX ON orders (user_id) WHERE status = 'pending';      -- 部分索引
CREATE INDEX ON users (lower(email));                           -- 表达式索引
CREATE INDEX ON articles USING gin (to_tsvector('simple', body)); -- 全文
```

这类索引在"只查活跃数据"或"按函数结果查询"时能省一大半扫描。

**③ JSON 支持**

- MySQL 8：`JSON` 类型 + `->>` 操作符 + 生成列 + 多值索引，够用。
- PostgreSQL：`jsonb` + GIN 索引 + 丰富操作符，能做真正的半结构化查询与聚合。

```sql
-- PG：按 jsonb 字段过滤并建索引
SELECT * FROM events WHERE payload @> '{"type":"order.created"}';
CREATE INDEX ON events USING gin (payload);
```

如果业务里 JSON 用得重（事件、配置、日志），PG 优势明显。

**④ 复制**

- MySQL：主从（binlog）+ 组复制（MGR）+ InnoDB Cluster，生态成熟。
- PostgreSQL：流复制（物理）+ 逻辑复制（PG 10+），逻辑复制可做"按表同步"。

MySQL 的"半同步复制"能减少丢数据窗口；PG 的 `synchronous_commit = remote_apply` 更强但更慢。

**⑤ 扩展性**

- MySQL：插件式存储引擎（历史优势，现在基本只用 InnoDB）。
- PostgreSQL：**扩展生态**是最大差异——`pgvector`（向量）、`PostGIS`（地理）、`timescaledb`（时序）、`pg_partman`（分区）、`pg_cron`（定时）。

一个 PG 实例能覆盖"关系 + 向量 + 地理 + 时序"，这在中小团队里能省掉好几个中间件。

### 八个场景对号入座

| 场景 | 推荐 | 理由 |
| --- | --- | --- |
| 电商订单（高并发写） | MySQL | 生态成熟、分库分表方案多 |
| 内容/论坛/博客 | PostgreSQL | 复杂查询、全文、JSON |
| 报表与 BI | PostgreSQL | 窗口函数、CTE、并行查询强 |
| 地理信息（附近的人） | PostgreSQL + PostGIS | 无可替代 |
| AI 应用（向量检索） | PostgreSQL + pgvector | 省一套向量库 |
| 时序指标（IoT） | PostgreSQL + TimescaleDB 或专用 TSDB | 分区与压缩 |
| 已有大量 PHP/Java 老系统 | MySQL | 迁移成本最低 |
| 强一致金融账务 | 两者皆可，看团队 | 关键在事务设计与审计，不在数据库品牌 |

### 迁移要付的代价

从 MySQL 到 PG（或反之）不只是改驱动：

1. **SQL 方言**：`AUTO_INCREMENT` vs `SERIAL/IDENTITY`、`LIMIT x,y` vs `LIMIT y OFFSET x`、字符串拼接、日期函数。
2. **大小写敏感**：MySQL 表名默认不敏感（取决于文件系统），PG 一律小写，双引号才保留大小写。
3. **隐式转换**：MySQL 宽松（`'123'` 能比 int），PG 严格（直接报错）。这会让一批"以前能跑的 SQL"失败。
4. **锁与隔离级别**：应用层依赖 RR 的逻辑到 PG 上可能出幻读问题。
5. **运维工具链**：备份、监控、慢日志分析工具全要换。

经验上，**同规模迁移的工作量约等于"重写 30% 的数据访问层"**。

### "两个都上"的常见架构

不少公司实际是：

```
交易主库：MySQL（团队熟悉、分库分表成熟）
分析/报表库：PostgreSQL（复杂查询、pgvector 做推荐召回）
```

通过 CDC（Debezium/Canal）把 MySQL 的变更同步到 PG，分析查询全部打到 PG，主库只承担交易。这个组合在很多团队里跑得很好。

### 选型时真正该问的四个问题

1. **团队最熟哪个？** 熟悉度比纸面性能重要十倍。
2. **有没有必须的能力？**（PostGIS、pgvector、特定存储过程）
3. **数据量与增长曲线？** 单表过亿、写入百万/天，就要考虑分片方案，这时 MySQL 的成熟方案更多。
4. **运维能不能跟上？** PG 的 vacuum/bloat、MySQL 的主从延迟，各有各的坑。

### 一句话总结

数据库选型不是选"最好的"，而是选**团队能长期运维好的**。有特殊能力需求（向量、地理、时序）时，PostgreSQL 的扩展生态是决定性优势。
