---
title: 部署日志平台：OpenSearch 与 Dashboards
module: 进阶篇
summary: 单节点与多节点部署、索引模板与分片、Filebeat 采集、保留与容量，五个"日志平台上线就卡"的原因。
minutes: 50
---

## 一、先弄懂它是什么

**日志平台 = 采集 + 存储 + 检索 + 展示，四段流水线。OpenSearch 是"搜索型存储"，不是"数据库"。**

```
应用日志 → 采集器（Filebeat/Vector）→ 缓冲 → 索引存储（OpenSearch）→ 查询（Dashboards）
```

**它解决的问题**：把散落在几十台机器上的文本日志，变成"可以按时间、服务、trace_id 秒级检索"的数据。没有它，排障只能一台台 `grep`。

### 为什么用搜索引擎存日志

```
① 倒排索引：按关键词查询是"查索引"，不是扫全文
② 按时间分区（索引）：热数据小、查询快，老数据可以整体删
③ 列式压缩：日志字段重复度高，压缩比通常 3-5 倍
```

代价：写入比数据库重（要建索引），所以日志平台**不适合当业务数据库**，也不适合"强一致事务"。

### 核心概念（先分清，否则配置全乱）

| 概念 | 是什么 | 关键参数 |
| --- | --- | --- |
| Cluster | 集群，一个逻辑单元 | `cluster.name` 必须全一致 |
| Node | 进程实例，可承担 master/data/ingest | 小集群常三角色合一 |
| Index | 索引，类似"表"，按天滚动 | 分片数、副本数 |
| Shard | 分片，索引的水平切分 | 主分片数建索引时定死 |
| Replica | 副本，高可用 + 读扩展 | 单节点设 0，否则永远 unassigned |
| 模板 | 新索引的默认设置 | 分片/副本/refresh |
| ILM/ISM | 生命周期：热→温→冷→删 | 保留期靠它 |

### 写入与查询的机制差异

```
写入：先进内存 buffer + translog，定期 refresh（默认 1s）才可被搜到
      → 这就是"日志写进去了但查不到"的原因（还没 refresh）
查询：分片并行 → 各分片返回 topN → 协调节点归并
      → 分片越多，归并开销越大（不是越多越快）
```

### 容量怎么估（必须先算）

```
原始日志/天 = 事件数 × 平均事件大小
存储占用 ≈ 原始 × (1/压缩比 3~5) × (1 + 副本数) × 保留天数
例：50GB/天，压缩 4 倍，1 副本（即 2 份），保留 30 天
    ≈ 50 × 0.25 × 2 × 30 = 750GB
```

**判据**：先算这个数，再决定节点数与磁盘。跳过这步，通常两个月后磁盘满。

### 和 ELK 的关系

```
ELK = Elasticsearch + Logstash + Kibana（Elastic 公司）
OpenSearch = Elasticsearch 7.10 分叉后的开源版本 + Dashboards
```

接口与查询语法高度相似，选哪个看许可与生态，不看"谁更强"。

### 先算容量，再选方案

```
每天日志量 × 保留天数 × 副本数 ≈ 原始数据
ES/OpenSearch 压缩比约 1/3 ~ 1/5（文本）
```

**判据**：每天 50GB 原始日志、保留 30 天 → 至少准备 500GB 可用空间。

### 单节点（够小团队用）

```yaml
# docker-compose.yml（开发/小规模）
services:
  opensearch:
    image: opensearchproject/opensearch:2.17.1
    environment:
      - discovery.type=single-node
      - OPENSEARCH_INITIAL_ADMIN_PASSWORD=<强密码>
      - "OPENSEARCH_JAVA_OPTS=-Xms2g -Xmx2g"
    ulimits: { memlock: { soft: -1, hard: -1 }, nofile: { soft: 65536, hard: 65536 } }
    volumes: [ "./data:/usr/share/opensearch/data" ]
    ports: ["9200:9200"]
```

**要点**：

```
① 堆内存 ≤ 物理内存一半，且 Xms = Xmx
② 必须调 memlock/nofile（否则起不来）
③ vm.max_map_count ≥ 262144
```

```bash
sysctl -w vm.max_map_count=262144
```

### 多节点（生产最小形态）

```
3 个节点：每节点既是 data 又是 master-eligible
避免"专用 master" 在小集群里浪费
```

```yaml
cluster.name: logs
node.name: node-1
discovery.seed_hosts: ["10.0.0.31", "10.0.0.32", "10.0.0.33"]
cluster.initial_master_nodes: ["node-1", "node-2", "node-3"]
```

**注意**：`initial_master_nodes` 只在首次启动时写，之后删掉，否则重启会脑裂。

### 索引模板（决定性能）

```json
PUT _index_template/logs
{
  "index_patterns": ["logs-*"],
  "template": {
    "settings": {
      "number_of_shards": 3,
      "number_of_replicas": 1,
      "refresh_interval": "30s"
    }
  }
}
```

```
① 分片数按节点数定（不要 1 索引 20 分片）
② refresh_interval 30s（日志不需要秒级可见）
③ 单一索引别超 50GB
```

### 采集（Filebeat）

```yaml
filebeat.inputs:
  - type: filestream
    paths: ["/var/log/app/*.log"]
    parsers:
      - ndjson:
          target: ""
          add_error_key: true
output.elasticsearch:
  hosts: ["https://10.0.0.31:9200"]
  username: "ingest"
  password: "${ES_PWD}"
```

**判据**：日志是 JSON 就用 `ndjson` 直解，别用正则硬切。

### 保留与生命周期

```json
PUT _plugins/_ism/policies/logs_30d
{
  "policy": {
    "states": [
      { "name": "hot", "actions": [], "transitions": [{ "state_name": "delete", "conditions": { "min_index_age": "30d" } }] }
    ]
  }
}
```

**"日志全留"** → 磁盘半年就满。

### 五个"上线就卡"

**① 堆内存给太大**

```
超过 32G 失去指针压缩；超过物理一半被 swap
```

**② 分片过多**

```
每分片有固定开销 → 集群状态更新变慢
```

**③ 单节点却设了 1 副本**

```
副本永远 unassigned → 集群 yellow，白占资源
```

**④ 写入无节流**

```
突发日志把队列打满 → 采集端丢日志
```

**⑤ 查询不做限制**

```
Kibana 拉全量聚合 → OOM
```

### 检查清单

```
□ 容量按"日量 × 天数 × 副本"算过
□ 堆 ≤ 物理一半，Xms=Xmx
□ vm.max_map_count 已调
□ 多节点用奇数 master
□ initial_master_nodes 首次后移除
□ 索引模板定分片/副本/refresh
□ 采集端解析结构化日志
□ 有保留策略（ISM/ILM）
□ 写入有节流与队列监控
□ 有集群健康与磁盘水位告警
```
