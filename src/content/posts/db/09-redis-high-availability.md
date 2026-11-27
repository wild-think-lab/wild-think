---
title: Redis 高可用：主从、哨兵、Cluster 到底选哪个
description: 三种模式的故障切换机制与盲点、哨兵部署要点、Cluster 的分片与限制、以及"切了主但客户端没切"的常见事故。
date: 2026-11-27
tags: [Redis, 高可用, 哨兵, Cluster, 缓存]
---

### 先想清楚要解决什么

| 需求 | 方案 |
| --- | --- |
| 只读扩展（读多写少） | 主从复制 |
| 主挂了能自动切 | 主从 + 哨兵 |
| 数据量超过单机内存 / 写入超过单机 | Cluster 分片 |
| 只是缓存，丢了能重建 | 高可用不是必需，重点是"别拖垮数据库" |

**最常见的错误**：为了"高可用"上 Cluster，结果 10GB 数据分到 3 个节点，运维复杂度翻三倍，收益为零。

### 主从复制

```conf
# 从节点
replicaof 10.0.0.1 6379
replica-read-only yes
```

```bash
redis-cli -h 10.0.0.2 info replication
# role:slave  master_link_status:up  master_repl_offset:...
```

三个关键判断：

- `master_link_status:up` — 链路正常。
- `master_repl_offset` 差值持续增大 — 复制落后（网络或从节点太慢）。
- `repl_backlog` 太小 — 从节点断连后需要全量同步（会触发 fork + 传 RDB，主节点抖动）。

```conf
repl-backlog-size 64mb     # 大流量场景要加大，否则频繁全量同步
```

**主从的盲点**：主挂了没有任何自动切换，写全失败。

### 哨兵（Sentinel）

哨兵是独立进程，负责监控、判定、切换、通知。

```conf
# sentinel.conf
sentinel monitor mymaster 10.0.0.1 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 60000
sentinel parallel-syncs mymaster 1
```

部署要点：

1. **至少 3 个哨兵，且分布在不同的故障域**（不同物理机/可用区）。2 个哨兵在同一个宿主机上等于没有。
2. `quorum` 设为 `(哨兵数/2)+1`，避免脑裂。
3. 哨兵要能看到所有节点，**网络分区会导致"各自以为自己是主"**。
4. 哨兵会自动重写配置文件，**不要用配置管理工具强行覆盖 sentinel.conf**，否则会破坏它记住的拓扑。

客户端要支持哨兵协议：

```python
from redis.sentinel import Sentinel
s = Sentinel([('10.0.0.11',26379),('10.0.0.12',26379),('10.0.0.13',26379)], socket_timeout=0.5)
master = s.master_for('mymaster', socket_timeout=0.5)
```

`master_for` 会自动向哨兵问"现在谁是主"，切换后新连接会指向新主。

### Cluster

```bash
redis-cli --cluster create \
  10.0.1.1:6379 10.0.1.2:6379 10.0.1.3:6379 \
  10.0.2.1:6379 10.0.2.2:6379 10.0.2.3:6379 \
  --cluster-replicas 1
```

规则：

- 16384 个 slot 分布到主节点，key 用 CRC16 定位。
- **至少 3 主 3 从**，否则多数派投票无法完成。
- 多 key 操作要求 key 在同一个 slot：

```bash
# 用 hash tag 强制同槽
SET user:{1001}:name "a"
SET user:{1001}:age 30
MGET user:{1001}:name user:{1001}:age
```

不带 `{}` 的 `MGET k1 k2` 在 Cluster 下会直接报 `CROSSSLOT`。

限制要知道：

- 不支持跨 slot 的事务、`KEYS`、`SCAN` 全量（只能单节点扫）。
- `SELECT` 多库不可用，只有 db0。
- Lua 脚本里的 key 必须在同一 slot。

### 事故模式：切了主，客户端没切

真实场景：哨兵 30 秒完成切换，但**应用连接池里全是死连接**，之后所有请求报 `Connection refused`，直到重启。

原因：客户端只在"连接失败"时重连，但旧连接是"半死"（TCP 层没断，Redis 已不认），写入静默失败或读超时。

修法三条：

1. **客户端必须走哨兵/集群发现**，不要硬编码 IP。
2. **连接健康检查**：定期 `PING`，失败即重建连接。
3. **写入失败要有明确异常**，不能吞掉（缓存写失败通常可以降级，但必须计数告警）。

```python
# 简易健康检查
try:
    master.ping()
except redis.exceptions.ConnectionError:
    pool.disconnect()      # 全量重建
```

### 切换会不会丢数据？

会。异步复制意味着主在切换前写入但未同步的数据会丢。

评估：

```bash
# 主从偏移差
redis-cli info replication | grep offset
```

差值 = 可能丢失的写数量级。Redis 的 `WAIT` 命令可以同步等待：

```bash
WAIT 1 100    # 等至少 1 个从节点确认，超时 100ms
```

**只在真正不能丢的写入上用 `WAIT`**，它会显著增加延迟。

### 缓存场景的正确姿势

如果 Redis 只是缓存，高可用策略应该反过来简化：

1. 不追求零丢失，追求**快速恢复**（重启即可，数据能重建）。
2. 代码里必须有"缓存不可用"的降级路径（直接查库 + 限流）。
3. 多级缓存（本地 Caffeine + Redis）能显著降低 Redis 故障的影响面。

比任何高可用方案都更有效：**让 Redis 挂掉不是事故**。

### 选型决策表

| 条件 | 选 |
| --- | --- |
| 数据 < 20GB，读多写少 | 主从 + 哨兵 |
| 数据 > 50GB 或写 QPS > 单机上限 | Cluster |
| 强持久化要求（不能丢） | 不用 Redis 做唯一存储；用 PG/MySQL + Redis 做缓存 |
| 只想扛住故障 | 本地缓存 + 降级 + 快速重启 |
