---
title: 热 Key 与大 Key：Redis 里最难处理的两种"不均衡"
description: 怎么发现、怎么拆分、怎么防,以及五个"加了节点但压力没降"的原因。
date: 2026-10-17
tags: [数据库, Redis, 性能]
---

### 两种问题

```
大 Key：单个 key 的 value 太大（或元素太多）
热 Key：单个 key 的访问量远高于其他
```

**"集群加了节点"** 对这两类问题几乎无效（它们在同一个分片上）。

### 怎么发现大 Key

```bash
# 扫描（生产慎用，加 -i 限速）
redis-cli --bigkeys -i 0.1

# 更精确：按内存排序
redis-cli --memkeys --memkeys-samples 5

# 单 key 详情
redis-cli memory usage mykey
redis-cli strlen mykey      # string
redis-cli llen mylist       # list
redis-cli hlen myhash
```

**判据**：

```
String > 1MB、集合元素 > 1万、Hash 字段 > 1万 → 都算大
```

### 怎么发现热 Key

```
① 客户端埋点（上报 key 访问计数）
② 代理层统计（如 twemproxy/自研代理）
③ redis-cli --hotkeys（需 maxmemory-policy 为 lfu）
④ 监控 slowlog + 命令统计
```

```bash
redis-cli config set maxmemory-policy allkeys-lfu
redis-cli --hotkeys
```

**"只看 QPS 高"** 不能定位到 key。

### 大 Key 的害处

```
① 删除/过期阻塞主线程（DEL 一个大 hash 可能几百 ms）
② 网络带宽打满（一次取 10MB）
③ 主从同步延迟（大 key 复制慢）
④ 集群迁移/扩缩容卡住（迁移一个巨大 slot）
```

**"突然卡顿"** 经常是"某个大 key 过期了"。

### 大 Key 的处理

```
① 拆分：hash 按字段分片（user:1:profile / user:1:orders）
② 压缩：value 用 gzip/protobuf（注意 CPU 成本）
③ 分页读取：不要一次 hmget 全部
④ 异步删除：UNLINK 而不是 DEL
⑤ 迁移时单独处理
```

```bash
redis-cli unlink bigkey   # 后台线程释放
```

### 热 Key 的处理

```
① 本地缓存（客户端/网关层缓存 1–5s）
② 多副本 key（key:0..9 随机选一个，写入时全写或定时同步）
③ 读扩散到从节点（读写分离）
④ 限流（对热点接口做保护）
```

**"多副本"** 的本质：把一个 key 的压力摊到 N 个分片。

```python
# 读：随机副本
idx = random.randint(0, 9)
key = f"hot:{idx}"
# 写：写主 key，异步/定时刷新副本
```

### 五个"加了节点但压力没降"

**① key 落在同一分片**

```
热 key 只有一个 → 加节点不改变它的位置
```

**② 客户端连接没分散**

```
所有客户端连同一个节点（配置写死）
```

**③ 大 key 导致单线程阻塞**

```
CPU 没满但延迟高 → 是阻塞不是算力
```

**④ 主从同步拖慢**

```
大 key 复制导致从节点延迟，读写分离也救不了
```

**⑤ 热点来自"扫描类"操作**

```
KEYS */SMEMBERS 大集合 → 每次都全量
```

### 预防（设计阶段）

```
① 不给单个 key 塞"无限增长"的集合（如全站排行榜用 zset 但要分片）
② 统一序列化规范（防止"顺手塞了个大 JSON"）
③ 有 key 命名规范（含业务/类型/维度）
④ 有"大 key 巡检"（每日跑一遍 --bigkeys 到报表）
⑤ 有"热 key 告警"（某 key QPS 超阈值）
```

### 检查清单

```
□ 有大 key 巡检（每日）
□ 有热 key 统计（埋点/代理/lfu）
□ 大 key 用 UNLINK 删除
□ 大集合有拆分规范
□ 热点读有本地缓存或副本
□ 关键接口有限流
□ 集群迁移预案（大 key 单独处理）
□ 主从延迟有监控
□ 禁止 KEYS *（用 SCAN）
□ 有"key 设计评审"
```
