---
title: Elasticsearch 运维：分片、堆内存与"集群变红"
description: 分片数怎么定、堆内存为什么不能超过 31G、red/yellow 的处置顺序，以及五个把集群搞崩的查询。
date: 2026-11-27
tags: [Elasticsearch, 搜索, 运维]
---

### 分片数怎么定

**经验公式**：

```
单分片大小：10–50GB（日志场景可到 50GB）
分片数 = 数据总量 / 单分片大小
单节点分片数：< 20 个/GB 堆（经验：每 GB 堆最多 20 分片）
```

**例**：

```
每天 200GB 日志，保留 30 天 = 6TB
按 30GB 一个分片 → 200 个主分片
3 节点 → 每节点 67 个分片（有点多）
→ 改用 ILM 按天滚动索引（每天 7 个分片 × 30 天 = 210）
```

**"分片过多"的后果**：

```
① 每个分片都是 Lucene 索引（有固定开销）
② 集群状态（cluster state）变大，每次变更都要广播
③ 查询要打到所有分片再合并（慢）
```

**"分片过少"的后果**：

```
无法水平扩展（一个分片只能在一个节点）
单分片太大 → 恢复/迁移慢
```

**索引模板（按天滚动）**：

```json
PUT _index_template/logs
{
  "index_patterns": ["logs-*"],
  "template": {
    "settings": {
      "number_of_shards": 3,
      "number_of_replicas": 1,
      "index.lifecycle.name": "logs-policy"
    }
  }
}
```

### 堆内存为什么不能超过 31GB

```
JVM 在堆 > 32GB 时无法使用"压缩指针"（compressed oops）
→ 指针从 4 字节变 8 字节 → 实际可用内存反而下降
```

**建议**：

```
堆：不超过物理内存的 50%，且不超过 31GB
剩下的内存留给文件系统缓存（Lucene 严重依赖 page cache）
```

**典型配置（64GB 机器）**：

```yaml
# jvm.options
-Xms31g
-Xmx31g        # 必须相等（避免扩容抖动）
```

**不要给 ES 太大堆**：

```
堆越大 → GC 停顿越长 → 查询毛刺越明显
ES 的性能靠 page cache，不是靠堆
```

### 集群变红/变黄

**颜色含义**：

```
green ：所有主分片与副本都分配了
yellow：主分片正常，但有副本未分配（数据完整，冗余不足）
red   ：有主分片未分配（数据不完整，部分索引不可用）
```

**处置顺序**：

```bash
# 1. 看哪些索引 red/yellow
GET _cluster/health?level=indices

# 2. 看为什么未分配
GET _cluster/allocation/explain
```

**最有用的是 `allocation/explain`**：它会直接告诉你原因（磁盘不足、节点数不够副本、分配规则限制）。

**常见原因与处理**：

| 原因 | 处理 |
| --- | --- |
| 节点数 < 副本数 + 1 | 加节点，或降副本数 |
| 磁盘水位超限 | 清理数据/加盘/调水位 |
| 分配规则（shard allocation awareness）不满足 | 改规则 |
| 分片损坏 | 从快照恢复 |

**磁盘水位（默认）**：

```
low watermark  85%  → 不再分配新分片
high watermark 90%  → 开始迁走分片
flood stage    95%  → 索引变只读（最危险）
```

**这个水位是"每块盘"而不是"整节点"**，很容易被忽略。

### 五个把集群搞崩的查询

**① 深分页**

```json
{ "from": 100000, "size": 10 }
```

**为什么危险**：每个分片都要取 100010 条再合并，内存与 CPU 爆炸。

**正确做法**：

```json
// search_after（游标）
{ "size": 10, "search_after": [1234567890], "sort": [{"@timestamp": "asc"}] }
```

**② 聚合的基数太大**

```json
{ "aggs": { "by_user": { "terms": { "field": "user_id", "size": 100000 } } } }
```

**危险**：每个分片都要建 10 万桶 → 内存爆。

**处理**：

```
① 降低 size（默认 10 就够）
② 用 composite aggregation 分页聚合
③ 大数据量走数仓（不是 ES 的活）
```

**③ 通配符/正则查询**

```json
{ "query": { "wildcard": { "msg": "*timeout*" } } }
```

**危险**：无法用索引，全量扫描。

**④ 一次取太多字段**

```json
{ "size": 10000, "_source": true }
```

**处理**：`_source: ["field1"]` 只取需要的，或 `size` 降到合理值。

**⑤ 脚本查询（painless）**

```json
{ "query": { "script": { "script": "doc['a'].value > params.x" } } }
```

**危险**：脚本执行慢，且可能被注入（如果拼接字符串）。

### 写入优化

```
① 批量（bulk），每批 5–15MB
② 减少 refresh 频率（写多读少时 refresh_interval: 30s）
③ 副本数写入期降为 0，写完再调回（仅批量导入时）
④ 用 ILM 滚动索引（避免单索引无限增长）
⑤ mapping 明确字段类型（不要 dynamic 导致类型猜测）
```

**`refresh_interval` 的取舍**：

```
1s（默认）→ 近实时搜索，但写性能有代价
30s      → 写更快，但数据延迟 30 秒可见
-1       → 完全不自动 refresh（批量导入时用）
```

### 快照与恢复

```bash
# 注册仓库（S3/文件系统）
PUT _snapshot/backup
{ "type": "fs", "settings": { "location": "/mnt/backup", "compress": true } }

# 创建快照
PUT _snapshot/backup/snap-20261127
{ "indices": "logs-*", "ignore_unavailable": true }

# 查看
GET _snapshot/backup/_all

# 恢复
POST _snapshot/backup/snap-20261127/_restore
{ "indices": "logs-2026.11.26", "rename_pattern": "(.+)", "rename_replacement": "restored-$1" }
```

**注意**：

```
① 快照仓库必须在所有节点的 path.repo 里
② 恢复前索引要关闭（或改名恢复）
③ 快照是"增量"的（第一次全量，后续只存变化）
```

### 监控要看什么

```bash
GET _cluster/health
GET _cat/nodes?v&h=name,heapPercent,diskAvail,load,cpu
GET _cat/indices?v&s=store.size:desc
GET _cat/shards?v&h=index,shard,prirep,state,node
```

**五个关键指标**：

```
① 堆使用率（> 75% 要关注，> 85% 危险）
② 磁盘水位（> 85% 会停止分配）
③ 查询延迟 P99
④ 写入拒绝数（thread pool rejected）
⑤ 未分配分片数
```

**`thread pool rejected` 是很强的信号**：

```
写入队列满 → 拒绝 → 数据可能丢
→ 要么加节点，要么降写入速率
```

### 检查清单

```
□ 单分片 10–50GB，每 GB 堆 < 20 分片
□ 堆 ≤ 31GB 且 ≤ 物理内存 50%
□ Xms = Xmx
□ 有 ILM 滚动索引
□ 磁盘水位监控（每块盘）
□ red/yellow 用 allocation/explain 定位
□ 禁用深分页（用 search_after）
□ 聚合 size 收敛
□ bulk 批量写入
□ 有快照且演练过恢复
□ 监控堆、拒绝数、未分配分片
```
