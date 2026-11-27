---
title: 实验报告：ELK 日志平台搭建与检索实战
description: 目的/环境/步骤/验证：Elasticsearch 单节点、Logstash 收 Nginx 日志、Kibana 检索面板，配索引模板、ILM 生命周期与三个真实检索场景。
date: 2022-08-04
tags: [ELK, Elasticsearch, Logstash, 日志, 实验报告]
---

### 实验目的

把分散在多台机器上的 Nginx 访问日志集中到一处，能做到三件事：

1. 按状态码、耗时、IP 秒级检索；
2. 按天自动滚动索引，保留 30 天后自动清理；
3. 出故障时用一条查询定位"哪个接口在什么时候开始变慢"。

### 实验环境

| 角色 | 地址 | 组件 |
| --- | --- | --- |
| 日志平台 | 192.168.1.30 | Elasticsearch 9.x、Kibana、Logstash |
| 应用机 | 192.168.1.31 | Nginx（产生日志） |
| 系统 | Ubuntu 24.04 | 8C16G / 100G 磁盘 |

内存分配建议（单机全栈）：

```
Elasticsearch 堆 4G，Logstash 堆 1G，Kibana 512M
剩余留给文件系统缓存（ES 非常依赖 page cache）
```

### 步骤一：起 Elasticsearch

```bash
docker network create elk
docker run -d --name es --network elk \
  -p 9200:9200 \
  -e discovery.type=single-node \
  -e ES_JAVA_OPTS="-Xms4g -Xmx4g" \
  -e xpack.security.enabled=false \
  -v /data/es:/usr/share/elasticsearch/data \
  docker.elastic.co/elasticsearch/elasticsearch:9.1.0
```

`-Xms` 与 `-Xmx` 必须相等（否则堆震荡）。**堆不要超过物理内存的 50%，也不要超过 31G**（超过会失去指针压缩）。

验证：

```bash
curl -s localhost:9200 | jq '.version.number, .cluster_name'
curl -s localhost:9200/_cluster/health | jq '.status'
```

`status` 是 `green`（单节点无副本，green 即正常）。

### 步骤二：索引模板与生命周期

先建模板，保证字段类型正确（否则第一次写入后类型就固定了）：

```bash
curl -XPUT localhost:9200/_index_template/nginx-logs -H 'Content-Type: application/json' -d '
{
  "index_patterns": ["nginx-*"],
  "template": {
    "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
    "mappings": {
      "properties": {
        "@timestamp":   { "type": "date" },
        "client_ip":    { "type": "ip" },
        "method":       { "type": "keyword" },
        "path":         { "type": "keyword" },
        "status":       { "type": "integer" },
        "bytes":        { "type": "long" },
        "request_time": { "type": "float" },
        "upstream_time":{ "type": "float" },
        "ua":           { "type": "text" }
      }
    }
  }
}'
```

`keyword` 与 `text` 的区别：前者用于精确过滤与聚合，后者用于全文检索。**状态码用 integer 才能做范围查询**，用 keyword 就只能精确匹配。

ILM（索引生命周期）：

```bash
curl -XPUT localhost:9200/_ilm/policy/nginx-policy -H 'Content-Type: application/json' -d '
{
  "policy": {
    "phases": {
      "hot":    { "actions": {}, "min_age": "0ms" },
      "delete": { "actions": { "delete": {} }, "min_age": "30d" }
    }
  }
}'
```

然后在模板里挂上 `"lifecycle": {"name": "nginx-policy"}`，或让 Logstash 输出时指定。

### 步骤三：Logstash 采集

`/etc/logstash/conf.d/nginx.conf`：

```ruby
input {
  beats { port => 5044 }
  # 或者直接从文件读（实验用）
  file {
    path => "/var/log/nginx/access.log"
    start_position => "beginning"
    sincedb_path => "/dev/null"
    codec => plain { charset => "UTF-8" }
  }
}

filter {
  grok {
    match => { "message" => '%{IPORHOST:client_ip} - - \[%{HTTPDATE:ts}\] "%{WORD:method} %{URIPATH:path}[^"]*" %{INT:status:int} %{INT:bytes:int} "%{DATA:referer}" "%{DATA:ua}" rt=%{NUMBER:request_time} urt=%{NUMBER:upstream_time}' }
  }
  date {
    match => ["ts", "dd/MMM/yyyy:HH:mm:ss Z"]
    target => "@timestamp"
  }
  mutate {
    convert => { "request_time" => "float" "upstream_time" => "float" }
    remove_field => ["message", "ts", "event", "host", "@version"]
  }
  # 把健康检查丢掉，省空间
  if [path] =~ "^/healthz" { drop {} }
}

output {
  elasticsearch {
    hosts => ["http://es:9200"]
    index => "nginx-%{+YYYY.MM.dd}"
  }
}
```

grok 是最容易出错的一环，用 Kibana 的 Grok Debugger 或在线工具调通再上线。

### 步骤四：Kibana

```bash
docker run -d --name kibana --network elk -p 5601:5601 \
  -e ELASTICSEARCH_HOSTS=http://es:9200 \
  docker.elastic.co/kibana/kibana:9.1.0
```

进 `http://192.168.1.30:5601`，创建 Data View：`nginx-*`，时间字段选 `@timestamp`。

### 步骤五：三个真实检索场景

**① 5xx 集中在哪些接口**

```
status >= 500
```

按 `path` 聚合，按 count 倒序。看前 10 个路径就知道打哪儿。

**② 哪个时间段开始变慢**

```
request_time > 0.5
```

时间直方图按 1 分钟聚合，能看出"从 14:32 开始 P99 从 120ms 涨到 900ms"。

**③ 某次故障的完整链路**

```
path: "/api/v1/orders" and status: 502 and client_ip: "203.0.113.5"
```

拿到时间点后，去应用日志里查同一个时间窗，`traceId` 一对就全串起来了。

### 验证清单

| 项 | 方法 | 期望 |
| --- | --- | --- |
| 索引创建 | `curl localhost:9200/_cat/indices?v` | 有 `nginx-2026.11.27` |
| 文档数量 | `curl localhost:9200/nginx-*/_count` | 与日志行数量接近 |
| 字段类型 | `curl localhost:9200/nginx-*/_mapping` | `status` 是 `integer` |
| 查询可用 | Kibana Discover | 能按时间过滤出结果 |
| ILM 生效 | `curl localhost:9200/_ilm/explain` | 索引绑定了 policy |

### 常见故障

**ES 起不来，日志报 `max virtual memory areas vm.max_map_count [65530] is too low`**：

```bash
sysctl -w vm.max_map_count=262144
echo 'vm.max_map_count=262144' > /etc/sysctl.d/99-es.conf
```

**磁盘水位红了，索引变只读**：ES 默认 85% 触发 `read_only_allow_delete`。扩容或删旧索引：

```bash
curl -XDELETE 'localhost:9200/nginx-2026.10.*'
# 临时解锁
curl -XPUT 'localhost:9200/_all/_settings' -d '{"index.blocks.read_only_allow_delete": null}'
```

**字段类型冲突**：`status` 第一次写成字符串，后面再写数字会被拒。用 `_reindex` 重建，或直接删索引重来（日志类数据可以重灌）。

**Logstash 吃满 CPU**：grok 正则回溯开销大。给正则加锚点（`^`），并减少不必要的 `%{DATA}`。

### 实验结论

ELK 的价值不在"能存日志"，而在**能在秒级回答"什么时候开始、影响哪些接口、涉及哪些 IP"**。建好字段类型与 ILM，比事后调查询重要得多。
