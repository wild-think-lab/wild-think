---
title: Redis 运维治理：内存、淘汰策略与热 Key
description: 线上 Redis 最常见的四类问题：内存涨到打满、大 Key 拖慢全库、热 Key 打爆单核、持久化影响延迟。逐个给出定位命令与治理手段。
date: 2022-04-06
tags: [Redis, 缓存, 内存, 大Key, 运维]
---

### 先认清它的定位

Redis 是**内存数据库**，不是磁盘数据库的替代品。所有治理问题的根都在一句：**内存有限，而数据会无限增长。**

所以第一件事不是调参，是给每个实例定一个明确用途：

| 用途 | 建议 | 备注 |
| --- | --- | --- |
| 缓存 | 可丢，开 LRU 淘汰 | 最常用 |
| 会话 | 可丢但影响登录 | 单独实例，别和缓存混 |
| 队列 | 不可丢 | 开 AOF，不要设淘汰 |
| 计数/排行榜 | 可重建 | 定期落盘 |

**混用是最常见的错误**：缓存把内存挤满 → 淘汰策略把队列数据删了 → 业务丢消息。

### 内存打满怎么查

```bash
redis-cli info memory | egrep 'used_memory_human|used_memory_peak|maxmemory_human|mem_fragmentation_ratio'
redis-cli --bigkeys                 # 扫描各类最大 Key（生产建议低峰执行）
redis-cli --memkeys                 # 按内存排序（更准，但更慢）
redis-cli dbsize
```

关键指标：

- `used_memory` 接近 `maxmemory` → 已达上限。
- `mem_fragmentation_ratio > 1.5` → 碎片严重，考虑重启或 `activedefrag`。
- `evicted_keys` 在涨 → 正在大量淘汰，缓存命中率一定下降。

### 淘汰策略怎么选

```ini
maxmemory 4gb
maxmemory-policy allkeys-lru
```

| 策略 | 行为 | 适用 |
| --- | --- | --- |
| noeviction | 满了就报错 | 队列、不可丢数据 |
| allkeys-lru | 全部 Key 里淘汰最久未用 | 纯缓存（最常用） |
| volatile-lru | 只淘汰设了过期时间的 | 缓存与持久数据混用 |
| allkeys-random | 随机淘汰 | 访问分布均匀 |
| volatile-ttl | 优先淘汰快过期的 | 短生命周期缓存 |

**给每个 Key 设 TTL** 比任何淘汰策略都有效。没有 TTL 的缓存，迟早变成主数据库。

### 大 Key：一次操作卡死全库

Redis 单线程，一个 `DEL` 一个 200 万元素的 Hash，会阻塞主线程几百毫秒，所有请求排队。

定位：

```bash
redis-cli --bigkeys
# 或按元素数量近似判断
redis-cli object encoding mykey
redis-cli memory usage mykey
```

治理：

1. **拆分**：`user:1:profile`、`user:1:orders` 分开存，别塞一个巨型 Hash。
2. **删除用 `UNLINK`**（异步释放），不要用 `DEL`。
3. **扫描用 `SCAN`**，不要用 `KEYS *`。
4. 大集合做分页结构（`zset` 分段 1000 条一片）。

### 热 Key：单核打爆

一个 Key 每秒被访问几十万次，即使集群有 10 个节点，也只有 1 个节点在扛。

发现方式：

```bash
redis-cli --hotkeys            # 需要开启 LFU 或 maxmemory-policy 为 lfu
redis-cli monitor | head -100  # 只用于短时采样，生产慎用
```

治理：

- **本地缓存**：应用侧加一层 Caffeine/guava，把热 Key 挡在进程内。
- **Key 打散**：`hotkey:{0..9}` 拆成 10 份，读时随机或轮询。
- **读写分离**：热 Key 走副本读。
- **预生成**：排行榜这类周期性热点，提前算好放多个副本。

### 持久化与延迟

| 方式 | 特点 | 风险 |
| --- | --- | --- |
| RDB | 快照，恢复快 | 可能丢最后几分钟数据 |
| AOF everysec | 秒级持久 | 恢复慢，文件大 |
| AOF always | 基本不丢 | 延迟显著上升 |
| 混合（RDB+AOF） | 推荐 | 需 4.0+ |

`fork` 时复制页表会造成延迟抖动，内存大于 10GB 的实例 `save` 期间有明显卡顿。解法：主从结构里让从库做持久化，主库只读内存。

### 监控该看什么

```bash
redis-cli info stats | egrep 'instantaneous_ops|keyspace_hits|keyspace_misses|evicted_keys|rejected_connections'
redis-cli info clients | egrep 'connected_clients|blocked_clients'
redis-cli info persistence | egrep 'rdb_last_bgsave_status|aof_last_write_status'
```

配告警的四条：

1. 内存使用率 > 80%。
2. 命中率 < 90%（缓存失效或穿透）。
3. `rejected_connections > 0`（连接数打满）。
4. 持久化状态非 `ok`。

### 一页运维规范

- 每实例 `maxmemory` 显式设定，禁止裸跑。
- 所有缓存 Key 必须有 TTL，最长 24 小时为主。
- 禁止 `KEYS`、`FLUSHALL`、在线上跑 `--bigkeys`（低峰 + 从库）。
- 大集合用 `UNLINK` 删除。
- 主从 + 哨兵或 Cluster，别单点。
- 缓存与队列物理隔离实例。

Redis 用起来极简单，治理起来极考验规范。它的所有事故，几乎都能追到"没人管 Key 的生命周期"这一条。
