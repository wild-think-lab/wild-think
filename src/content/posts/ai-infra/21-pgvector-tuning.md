---
title: pgvector 调优：HNSW 参数、过滤与召回率
description: 从建索引到 ef_search，pgvector 真正影响延迟与召回率的几个旋钮，以及"加了索引反而更慢"的排查路径。
date: 2026-11-25
tags: [向量检索, PostgreSQL, 性能]
---

这两年问得最多的一个问题是"pgvector 能不能替代 Milvus"。答案取决于你的规模与过滤方式，而不是谁的 benchmark 好看。这篇只谈 pgvector 自己的旋钮：建索引怎么给内存、`ef_search` 怎么调、带过滤的查询为什么召回率崩。

## 先把三种距离算子分清

```sql
-- 余弦距离（要求向量已归一化，否则先 normalize）
SELECT id FROM docs ORDER BY embedding <=> $1 LIMIT 10;

-- 内积（返回负值，越小越相似）
ORDER BY embedding <#> $1 LIMIT 10;

-- L2
ORDER BY embedding <-> $1 LIMIT 10;
```

**坑**：`<=>` 是余弦**距离**（1 - 相似度），不是相似度。如果向量没归一化，余弦距离与内积结果会不一致，你会在"离线评测很好、线上排序乱"之间反复。

统一做法：写入前 `embedding = embedding / norm`，之后只用 `<=>` 或 `<#>` 之一。

## 建索引：内存比参数更重要

```sql
SET maintenance_work_mem = '4GB';

CREATE INDEX ON docs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

判据：

| 参数 | 默认 | 加大收益 | 代价 |
| --- | --- | --- | --- |
| `m` | 16 | 召回率更好、图更连通 | 索引更大、构建更慢 |
| `ef_construction` | 64 | 构建质量更高 | 构建时间线性上升 |
| `maintenance_work_mem` | 64MB | 构建不落盘、快数倍 | 吃内存 |

经验区间：

```
100 万条 1536 维：m=16 ef_construction=64 约 5-15 分钟（4 核）
                  索引大小约为原始向量的 1.2-1.6 倍
```

**"建索引报 out of memory"** → 不是参数问题，是 `maintenance_work_mem` 太小，构建时反复写临时文件。

## 查询：ef_search 是延迟与召回的开关

```sql
SET hnsw.ef_search = 100;    -- 默认 40
```

```
ef_search 越大 → 召回率越高、延迟越高（近似线性）
```

建议流程：

```
① 用 1000 条带标注的查询集，扫 ef_search ∈ {40, 80, 120, 200}
② 记录 recall@10 与 P95 延迟
③ 取"召回率达标的最低值"（常见 80-120）
```

**"调大 ef_search 没变化"** → 检查是否在会话里设的（连接池复用会重置），或用 `SET LOCAL` 在事务内。

## 带过滤的查询：召回率为什么崩

这是 pgvector 最容易翻车的地方。

```sql
-- 过滤条件命中率低时，HNSW 先按图搜 40 个候选，再过滤 → 可能只剩 2 条
SELECT id FROM docs
WHERE tenant_id = 42 AND embedding <=> $1
ORDER BY embedding <=> $1 LIMIT 10;
```

三种解法：

```
① 部分索引（按租户/分区，过滤变成"索引级"）
② 先过滤再搜（子查询 + 足够大的 ef_search）
③ 迭代扫描（pgvector 0.8+ 的 hnsw.iterative_scan）
```

```sql
-- 部分索引：租户隔离的硬办法
CREATE INDEX ON docs USING hnsw (embedding vector_cosine_ops)
  WHERE tenant_id = 42;
```

**判据**：过滤后候选 < 10 条 → 召回率必然崩，必须换方案而不是继续调大 ef_search。

## 换个类型省一半内存

```sql
-- 半精度（1536 维约省一半）
ALTER TABLE docs ALTER COLUMN embedding TYPE halfvec(1536);
CREATE INDEX ON docs USING hnsw (embedding halfvec_cosine_ops);
```

代价：精度下降，需要用你的评测集确认 recall 掉多少（通常 1-3 个点）。

## 五个"加了索引反而更慢"

**① 每次查询都算距离两次**（`ORDER BY` 写了两遍，或用子查询包了一层）

**② 索引没被用上**：`EXPLAIN` 里出现 `Seq Scan` → 向量列类型与 opclass 不匹配

**③ 过滤条件让规划器选了顺序扫描**：行数少时正常，行数大时要 `ANALYZE`

**④ 并发太高导致内存抖动**：HNSW 查询吃内存，`work_mem` 太小会频繁换出

**⑤ 写入与查询抢资源**：批量导入期间索引重建，查询延迟翻倍

## 一条可执行的验证命令

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM docs ORDER BY embedding <=> $1 LIMIT 10;
```

看三件事：是否 `Index Scan using ...hnsw`、`Execution Time`、`Buffers` 是否异常大。

## 检查清单

```
□ 向量已归一化（或明确只用一种算子）
□ maintenance_work_mem 足够（构建不落盘）
□ m / ef_construction 有评测依据
□ ef_search 在会话内设置（连接池注意）
□ 有 recall@10 评测集与基线
□ 带过滤查询有专门方案（部分索引/迭代扫描）
□ 大表已 ANALYZE
□ 内存类型按需换 halfvec
□ 有 P95 延迟与召回率监控
□ 批量导入与查询错峰
```
