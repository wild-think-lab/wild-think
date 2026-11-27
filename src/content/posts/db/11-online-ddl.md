---
title: MySQL 在线 DDL：几亿行的表怎么改字段不锁死业务
description: 三种 DDL 算法、INPLACE 与 COPY 的差别、gh-ost/pt-osc 的取舍、加索引与改类型的实际代价、以及变更窗口怎么定。
date: 2023-04-18
tags: [MySQL, DDL, 运维, 大表]
---

### 三种 DDL 算法

```sql
ALTER TABLE orders ADD COLUMN note VARCHAR(64), ALGORITHM=INPLACE, LOCK=NONE;
```

| 算法 | 行为 | 是否阻塞读写 |
| --- | --- | --- |
| `INSTANT` | 只改元数据（部分操作支持） | 不阻塞 |
| `INPLACE` | 原地重建/修改，边改边接受 DML | 多数不阻塞 |
| `COPY` | 建新表 + 拷数据 + 替换 | **全程阻塞写** |

判断能否用 INSTANT / INPLACE：

```sql
-- 加列（末尾）通常支持 INSTANT（8.0.12+）
ALTER TABLE t ADD COLUMN c INT, ALGORITHM=INSTANT;
```

MySQL 8.0.29+ 支持"任意位置加列（INSTANT）"，但仍有限制（不能超过 64 次 INSTANT 操作等）。

### 各操作的代价

| 操作 | 算法 | 代价 |
| --- | --- | --- |
| 加索引 | INPLACE | 扫描全表建索引，期间占用 IO |
| 加普通列（末尾） | INSTANT | 秒级 |
| 改列类型（int→bigint） | COPY | 全表重建，锁写 |
| 改字符集 | COPY | 全表重建，最贵 |
| 加外键 | INPLACE（需 `foreign_key_checks=0` 或表为空） | 有锁风险 |
| 删除列 | INPLACE（8.0） | 元数据 + 重建 |

**"加索引"并不便宜**：1 亿行表加一个索引，通常要几十分钟，期间 IO 明显升高，可能拖慢线上查询。

### 大表变更的三种方案

**① 原生 INPLACE（首选）**

```sql
SET SESSION lock_wait_timeout = 5;
ALTER TABLE orders ADD INDEX idx_created (created_at), ALGORITHM=INPLACE, LOCK=NONE;
```

`lock_wait_timeout=5` 很关键：如果拿不到元数据锁（有长事务占用），5 秒后放弃，而不是无限等。

**② pt-online-schema-change（Percona）**

```bash
pt-online-schema-change \
  --alter "ADD COLUMN note VARCHAR(64)" \
  D=app,t=orders \
  --max-load="Threads_running=30" \
  --critical-load="Threads_running=50" \
  --chunk-size=1000 \
  --execute
```

原理：建新表 → 建触发器同步增量 → 分块拷数据 → 原子 rename。

代价：

- 触发器带来额外开销（写入放大）。
- 需要双倍磁盘空间。
- 有外键的表要额外处理（`--alter-foreign-keys-method`）。

**③ gh-ost（GitHub）**

```bash
gh-ost \
  --host=127.0.0.1 --database=app --table=orders \
  --alter="ADD COLUMN note VARCHAR(64)" \
  --max-load=Threads_running=30 \
  --critical-load=Threads_running=50 \
  --allow-on-master \
  --execute
```

原理：读 binlog 同步增量（不用触发器），可在从库上"演练"，有暂停/恢复按钮。

对比：

| | pt-osc | gh-ost |
| --- | --- | --- |
| 增量同步 | 触发器 | binlog |
| 写入开销 | 较高 | 低 |
| 可暂停 | 否 | 是 |
| 依赖 | Perl | Go 二进制 |
| 外键支持 | 有处理 | 弱 |

**推荐 gh-ost**：对主库写入影响更小，能暂停，能在从库验证。

### 变更窗口与风险评估

```
风险 = 表大小 × 操作代价 × 业务敏感度
```

| 表大小 | 建议 |
| --- | --- |
| < 100 万行 | 原生 INPLACE 直接在低峰期做 |
| 100 万–5000 万 | INPLACE（加索引）或 gh-ost，低峰期 |
| > 5000 万 | gh-ost，且分多次（先加列、再建索引） |
| > 1 亿 | 考虑归档/分表，而不是"硬改" |

三个必查：

```sql
-- 表大小与行数
SELECT table_rows, round(data_length/1024/1024) AS data_mb,
       round(index_length/1024/1024) AS idx_mb
FROM information_schema.tables
WHERE table_schema='app' AND table_name='orders';

-- 是否有长事务（会阻塞 DDL 拿元数据锁）
SELECT trx_id, trx_started, trx_query
FROM information_schema.innodb_trx
ORDER BY trx_started;
```

### 双写与回滚

大表变更一旦开始，中途失败会留下临时表与触发器（pt-osc）。回滚方式：

- **gh-ost**：`--panic` 停止，直接删除 `_gho` 表即可。
- **pt-osc**：需要 drop 触发器与新表，确认原表未被 rename。

变更前必须演练一次：

```bash
# 在预发环境用同样的表结构与数据量跑一遍
```

### 一个真实的时间估算

订单表 2 亿行，加一个索引：

```
gh-ost：约 90 分钟（chunk 1000，限流 Threads_running=30）
原生 INPLACE：约 45 分钟，但 IO 峰值更高
```

估算公式（粗略）：

```
时间 ≈ 表大小(GB) × 每 GB 处理时间
每 GB 处理时间：SSD 约 1–3 分钟，机械盘 5–10 分钟
```

**留 2 倍余量**，并准备好"中途放弃"的判断点。

### 变更清单

```
□ 确认操作能否用 INSTANT / INPLACE（先 EXPLAIN 或小表试）
□ 表大小、索引大小、长事务已检查
□ 设置 lock_wait_timeout，避免无限等
□ 大表走 gh-ost，并配 max-load/critical-load 限流
□ 变更期间盯 IO、复制延迟、慢查询
□ 有明确的放弃条件（如复制延迟 > 30s 就暂停）
□ 变更后验证：结构（SHOW CREATE TABLE）、数据量、业务功能
```
