---
title: 部署日志平台：OpenSearch 与 Dashboards
module: 进阶篇
summary: 单节点与多节点部署、索引模板与分片、Filebeat 采集、保留与容量，五个"日志平台上线就卡"的原因。
minutes: 50
---

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
