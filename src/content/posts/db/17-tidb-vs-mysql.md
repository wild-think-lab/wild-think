---
title: TiDB 值不值得上：和 MySQL 分库分表的正面比较
description: TiDB 的架构、什么时候真的需要它、五个成本项、迁移路径，以及"上了 TiDB 反而更慢"的三个原因。
date: 2026-11-27
tags: [TiDB, MySQL, 数据库选型]
---

### TiDB 的架构

```
TiDB Server（无状态 SQL 层，可水平扩展）
    ↓
TiKV（分布式 KV 存储，数据分 Region 复制）
    ↓
PD（Placement Driver：元数据 + 调度）
    ↓
TiFlash（列存，用于分析查询）
```

**关键特性**：

```
① MySQL 协议兼容（大部分 SQL 能用）
② 水平扩展（加 TiKV 节点即扩容）
③ HTAP（TiKV 行存做 OLTP，TiFlash 列存做 OLAP）
④ 强一致（Raft 多数派）
```

### 什么时候真的需要它

**四个信号**：

```
① 单表 > 10 亿行，且还在快速增长
② 写入 QPS > 5000（单机 MySQL 上限附近）
③ 存储 > 2TB，备份/DDL 已经很痛
④ 需要"在线扩容"而不是"停机迁移"
```

**不够这些信号 → MySQL 分库分表更划算**。

### 五个成本项

| 成本 | 说明 |
| --- | --- |
| 机器 | 至少 3 TiKV + 3 PD + 2 TiDB（生产），起步 8 台 |
| 运维 | 需要懂 Region 调度、热点、TiFlash 同步 |
| 兼容 | 部分 MySQL 特性不支持（如部分存储过程、触发器） |
| 延迟 | 单条点查延迟高于单机 MySQL（多一次网络 + Raft） |
| 学习 | 事务模型（乐观/悲观）、执行计划差异 |

**"机器成本"最容易被低估**：TiDB 需要 3 副本，等于同样数据要 3 倍磁盘。

### 和分库分表的正面比较

| | MySQL 分库分表 | TiDB |
| --- | --- | --- |
| 扩容 | 要停机/迁数据 | 在线加节点 |
| 跨分片查询 | 中间件拼（复杂、慢） | 原生支持 |
| 分布式事务 | 需额外方案（如 Seata） | 原生 |
| 运维复杂度 | 高（中间件 + 多实例） | 中（组件少但新概念多） |
| 单条延迟 | 低 | 略高 |
| 成本 | 低（普通机器） | 高（三副本 + 内存要求高） |

**结论**：

```
数据量 < 1TB 且 QPS < 3000 → MySQL（含主从/读写分离）
数据量 1–5TB，QPS 中等 → 分库分表 or TiDB（看团队能力）
数据量 > 5TB 或写入极高 → TiDB
```

### 迁移路径

**推荐路径：先双写，再切读，最后切写**

```
① 用 DM（Data Migration）或 TiCDC 做全量 + 增量同步
② 应用双写（MySQL + TiDB），以 MySQL 为准
③ 逐步把读流量切到 TiDB（观察延迟与正确性）
④ 读全切后，把写切到 TiDB（MySQL 变成只读/备用）
⑤ 稳定 1–2 周后下线 MySQL
```

**每一步都可回滚**，这是迁移的核心原则。

### "上了 TiDB 反而更慢"的三个原因

**① 热点写入**

```
自增主键 + 单调递增 → 所有写入都打到最后一個 Region
→ 单个 TiKV 被打爆，其他闲着

对策：
- 用 AUTO_RANDOM（TiDB 的散列自增）
- 或业务层做 ID 打散（如雪花 ID + 前缀散列）
```

**这是最常见的"TiDB 比 MySQL 慢"的原因**。

**② 大事务**

```
TiDB 默认限制事务大小（txn-total-size-limit，默认 100MB）
超大事务会失败或极慢

对策：
- 拆小事务（批量更新分批）
- 调整参数（但不建议超过 1GB）
```

**③ 没建合适的索引 / 执行计划选错**

```
TiDB 的优化器与 MySQL 不同
某些在 MySQL 上很快的查询，在 TiDB 上走了全表扫

对策：
- EXPLAIN ANALYZE 看实际执行
- 用 TiFlash 做分析型查询（不要用 TiKV 跑大聚合）
- 检查统计信息是否准确（ANALYZE TABLE）
```

### 关键参数

```toml
# tikv.toml
[raftstore]
raft-base-tick-interval = "1s"

[storage]
# 单机数据量（默认 96MB 太小，建议按盘容量调）
region-split-size = "256MB"

[rocksdb]
max-open-files = 40960
```

```toml
# tidb.toml
[performance]
# 大事务上限
txn-total-size-limit = "1GB"
# 单条 SQL 内存限制
mem-quota-query = 1073741824
```

**`region-split-size` 调大**能减少 Region 数量（降低 PD 压力），但单个 Region 太大又影响调度灵活性。

### 监控看什么

```
① TiKV 的 Region 数量与热点（Grafana 的 TiKV 面板）
② PD 的调度是否频繁（频繁 = 数据分布不均）
③ TiDB 的慢查询（`SLOW_QUERY` 表，比 MySQL 详细）
④ TiFlash 的同步延迟（`information_schema.tiflash_replica`）
```

```sql
-- 看最近的慢查询
SELECT query_time, query, digest FROM information_schema.slow_query
ORDER BY query_time DESC LIMIT 5;

-- 看 TiFlash 同步状态
SELECT * FROM information_schema.tiflash_replica;
```

### 什么时候不要用 TiDB

```
① 数据量 < 500GB（MySQL 完全够）
② 有大量复杂存储过程/触发器（兼容性差）
③ 团队没人懂分布式（运维成本会失控）
④ 极度延迟敏感（如要求 < 1ms 的缓存型数据库）
⑤ 预算紧张（三副本 + 高内存配置）
```

**"为了技术先进而上 TiDB"是最常见的错误决策**。

### 检查清单

```
□ 有明确的"为什么 MySQL 不够"的数据依据
□ 起步至少 3 TiKV + 3 PD + 2 TiDB
□ 主键用 AUTO_RANDOM 或业务打散（避免热点）
□ 事务大小可控（拆分大批量更新）
□ 分析查询走 TiFlash
□ 迁移走"双写 → 切读 → 切写"
□ 监控 Region/热点/慢查询/TiFlash 延迟
□ 团队有人能处理 Region 调度问题
□ 不为"先进"而上，为"真的需要"而上
```
