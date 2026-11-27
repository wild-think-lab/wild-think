---
title: Milvus 与 pgvector：向量库到底选哪个
description: 两种方案的定位、索引与召回、容量与运维成本、六个"选完才发现不合适"的判据。
date: 2026-11-22
tags: [AI, 向量库, 检索]
---

### 先看清定位

```
pgvector：给已有 Postgres 加一个扩展
Milvus：专门的向量数据库（分布式、专用索引）
```

**"小规模就上 Milvus"** 往往是"为 10 万向量养一套集群"。

### 判据表

| 维度 | pgvector | Milvus |
| --- | --- | --- |
| 规模 | 十万–千万级 | 千万–十亿级 |
| 运维 | 复用现有 PG | 独立集群（etcd/MinIO/coordinator） |
| 事务一致性 | 与业务表同事务 | 最终一致（需自己处理） |
| 混合查询 | SQL 强（过滤 + 向量） | 支持标量过滤，但 SQL 弱 |
| 索引 | HNSW/IVFFlat | HNSW/IVF/DiskANN 等 |
| 成本 | 低（复用） | 高（独立组件） |

**"要跟业务表联查"** → pgvector 优势明显。

### pgvector 最小用法

```sql
CREATE EXTENSION vector;

CREATE TABLE doc (
  id bigserial PRIMARY KEY,
  content text,
  embedding vector(768)
);

-- HNSW 索引（查询快、构建慢）
CREATE INDEX ON doc USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 检索（余弦距离）
SELECT id, content, 1 - (embedding <=> $1) AS score
FROM doc
ORDER BY embedding <=> $1
LIMIT 10;
```

**`<=>` 是余弦距离**（`<->` 是 L2，`<#>` 是内积）——用错算子会"结果莫名其妙"。

### 关键参数

```
HNSW: m（每层连接数，16 常用）、ef_construction（构建质量）
查询时: SET hnsw.ef_search = 40;   -- 越大越准越慢
IVFFlat: lists（分区数，约 sqrt(行数)）
```

**"召回率低"** → 先调 `ef_search`/`probes`，再考虑换索引。

### Milvus 最小用法

```python
from pymilvus import connections, Collection, FieldSchema, CollectionSchema, DataType

connections.connect(host="milvus", port=19530)
schema = CollectionSchema([
    FieldSchema("id", DataType.INT64, is_primary=True),
    FieldSchema("vec", DataType.FLOAT_VECTOR, dim=768),
    FieldSchema("tenant", DataType.VARCHAR, max_length=64),
])
col = Collection("doc", schema)
col.create_index("vec", {"index_type": "HNSW", "metric_type": "COSINE", "params": {"M": 16, "efConstruction": 64}})
col.load()

col.insert([[1], [[0.1] * 768], ["t1"]])
res = col.search([[0.1] * 768], "vec", {"metric_type": "COSINE", "params": {"ef": 64}}, limit=10,
                 expr='tenant == "t1"')
```

**`expr` 过滤**在 Milvus 里是"先过滤再检索"还是"先检索再过滤"取决于版本与索引——要实测。

### 六个"选完才发现不合适"

**① 数据量估算错**

```
10 万 → pgvector 够；1 亿 → Milvus
（但"1 亿"要算上副本与索引膨胀）
```

**② 忘了更新**

```
向量要随文档变更重算（增量/全量成本）
```

**③ 多租户隔离**

```
pgvector：靠 WHERE；Milvus：靠 partition/expr
（都要防止"跨租户召回"）
```

**④ 混合检索**

```
关键词 + 向量 → 需要 rerank 或 RRF 融合（两个库都要自己做）
```

**⑤ 备份与恢复**

```
Milvus 要备份 etcd + 对象存储 + collection
pgvector 跟数据库一起备份（简单）
```

**⑥ 一致性**

```
业务写完 DB、向量还没写 → 检索不到（要 outbox/重试）
```

### 一个"够用"的落地顺序

```
1) 先 pgvector（复用现有库，最快验证效果）
2) 有性能瓶颈再评估 Milvus
3) 无论哪个，都要"写入失败可重试"与"重建索引"流程
```

### 检查清单

```
□ 规模估算（含副本与索引）
□ 距离算子与业务语义一致
□ 索引参数调过（ef_search/probes）
□ 有召回率评估集
□ 多租户隔离验证过
□ 向量更新策略明确
□ 备份包含向量数据
□ 有"重建索引"流程
□ 有混合检索的融合方案
□ 写入失败有重试/补偿
```
