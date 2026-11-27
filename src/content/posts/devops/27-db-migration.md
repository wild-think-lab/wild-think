---
title: 数据库变更流水线：别让 DBA 手工执行 SQL
description: 迁移工具选型、向前兼容的三步走、回滚策略、五个"上线时 SQL 卡住"的原因。
date: 2026-11-27
tags: [数据库, DevOps, 交付]
---

### 为什么需要流水线

```
手工执行 SQL 的问题：
① 没人知道"生产到底跑过哪些变更"
② 回滚靠记忆
③ 多环境不一致（测试库结构与生产不同）
④ 变更没有评审
```

**"变更即代码"** 是唯一可审计的做法。

### 工具选型

```
Flyway  ：Java 生态、SQL 优先、简单
Liquibase：XML/YAML/SQL，功能多
golang-migrate：Go 生态、轻量
Atlas   ：声明式 schema，能生成 diff
Alembic ：Python（SQLAlchemy）
```

**"声明式（Atlas/Prisma）"** 适合"以模型为准"，**"脚本式（Flyway）"** 适合"以历史为准"。

### 目录约定

```
migrations/
  V1__init.sql
  V2__add_order_status.sql
  V3__index_orders_user.sql
  R__views.sql          # 可重复执行
```

**命名即顺序**，不要用时间戳混排（`V1, V2, V10` 会按字符串排序出错，用 `V001`）。

### 向前兼容的三步走（最重要）

```
① 加：新增列/表/索引（旧代码不受影响）
② 双写/回填：新代码写新旧两处，异步回填历史
③ 删：确认无旧代码引用后，删旧列
```

**"一次改列名"** 会同时打断新旧版本（灰度期间必挂）。

### 大表变更

```
① 加索引：用 CONCURRENTLY（PG）或 Online DDL（MySQL 8）
② 加列：多数引擎很快（但默认值可能有坑）
③ 改类型：通常要重建表 → 用"新列 + 双写 + 切换"
④ 删列：先标记废弃，再删（避免回滚失败）
```

```sql
-- PostgreSQL 并发建索引（不锁表）
CREATE INDEX CONCURRENTLY idx_orders_user ON orders(user_id);

-- MySQL 8 在线 DDL
ALTER TABLE orders ADD INDEX idx_user (user_id), ALGORITHM=INPLACE, LOCK=NONE;
```

### 回滚策略（现实版）

```
① 能回滚的：加列/加索引（DROP 即可）
② 不能回滚的：删列/改类型（数据已丢）
→ 所以"删"要放到"稳定运行一周之后"的独立变更
```

**"一个变更里既加又删"** = 没有安全的回滚点。

### 五个"上线时 SQL 卡住"

**① 大表加索引锁表**

```
没加 CONCURRENTLY/ONLINE → 全表锁 → 业务超时
```

**② 变更在事务里跑很久**

```
长事务 + DDL → 锁等待雪崩
```

**③ 忘了设置 lock_timeout**

```sql
SET lock_timeout = '5s';
SET statement_timeout = '30s';
```

**④ 迁移在应用启动时跑（多副本同时跑）**

```
→ 用 initContainer + 分布式锁，或独立 Job
```

**⑤ 生产数据量比测试大 100 倍**

```
估算时间必须按"生产行数"
```

### 流水线结构

```
1) PR 提交迁移文件 → 自动在"临时库"跑一遍（验证语法/耗时）
2) 评审（DBA/owner）
3) 预发执行
4) 生产执行（独立 Job，不在应用启动时）
5) 记录（哪个版本、谁执行、耗时）
6) 验证（行数/索引/查询计划）
```

### 检查清单

```
□ 迁移文件进仓库（不手工执行）
□ 命名有顺序（V001）
□ 有"临时库预演"步骤
□ 向前兼容三步走
□ 大表用并发/在线 DDL
□ 设置 lock_timeout/statement_timeout
□ 迁移由独立 Job 执行（不随应用启动）
□ 有执行记录与审计
□ 删列放在独立变更（延后）
□ 有回滚方案（区分可回滚/不可回滚）
```
