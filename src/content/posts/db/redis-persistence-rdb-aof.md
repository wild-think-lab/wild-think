---
title: Redis 持久化取舍：RDB、AOF 与混合模式，到底丢多少数据
description: 三种持久化对应的是三个不同的失败场景：丢最近几分钟、丢最近一秒、以及 fork 卡住主线程。选型不是选"更安全"，而是选"能接受丢多少"。
date: 2026-11-16
tags: [Redis, 持久化, 缓存, 数据库]
---

问"Redis 会丢数据吗"，答案永远是"会，问题是多少"。RDB、AOF、混合持久化不是三档安全等级，而是三种不同的失败形态。

## 一、三种模式丢数据的窗口

| 模式 | 落盘时机 | 最坏丢失窗口 | 代价 |
| --- | --- | --- | --- |
| RDB | `save` 触发点（如 900s/1 次写） | 上一次快照之后的所有写 | fork 时内存翻倍风险、恢复快 |
| AOF `everysec` | 每秒 fsync | 约 1 秒 | 磁盘 IO 稳定、恢复慢（需重放） |
| AOF `always` | 每条命令 fsync | 理论上 0（除非磁盘缓存撒谎） | 吞吐掉一个数量级 |
| 混合（7.x 默认） | AOF 重写时用 RDB 格式打底 + 增量命令 | 约 1 秒 | 恢复快 + 丢失窗口小 |

一句话结论：**默认用混合持久化（`aof-use-rdb-preamble yes`），`appendfsync everysec`**。除非是计费、订单这类不可回滚场景，才考虑 `always`——并且要先接受吞吐下降。

## 二、RDB 的 `save` 规则不是"定时任务"

```conf
save 900 1        # 900 秒内至少 1 次写 → 存一次
save 300 10
save 60 10000
```

三个条件**任一满足**就触发。它的语义是"多久存一次"和"积攒多少写就存"的与逻辑组合，容易被误读成"每 900 秒存一次"。

真正危险的是 **fork 的内存放大**：`bgsave` 用 fork + COW，写入活跃时页会被复制，物理内存峰值可达 1.5–2 倍。表现是"做快照时内存告警、偶发 OOM、主线程毛刺"。

```bash
redis-cli info persistence | grep -E "rdb_last_bgsave_status|rdb_changes_since_last_save|latest_fork_usec"
redis-cli info memory | grep -E "used_memory_human|used_memory_rss_human|mem_fragmentation_ratio"
```

`latest_fork_usec` 超过 100ms 就说明 fork 已经影响延迟了，此时要么缩小实例（分片），要么关掉自动 RDB 只留 AOF。

## 三、AOF 的三个开关要一起看

```conf
appendonly yes
appendfsync everysec
no-appendfsync-on-rewrite no
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
```

- **`no-appendfsync-on-rewrite yes`** 会在重写期间停止 fsync，反而不丢数据但可能让磁盘缓冲堆积；设为 `no` 则重写时也 fsync，代价是延迟抖动。
- **重写阈值**：文件涨到上次重写后的两倍（且超过 64MB）才重写。业务写入量大时要下调 `min-size`，否则单文件膨胀到 GB 级，重启重放会很久。
- **AOF 文件损坏**：`redis-check-aof --fix` 只能截断到最后一个完整命令，丢的是尾部数据。这就是为什么生产要开 `aof-load-truncated yes`（默认开），启动时不至于直接失败。

## 四、主从与持久化的组合坑

最常见的生产事故链：**主库关闭 RDB + 从库重启 → 全量同步 → 主库 fork → 内存暴涨 → OOM**。

原因：从库重启后需要全量同步，主库必须 `bgsave` 生成 RDB 再传输。如果主库同时开着 RDB 落盘，这次 fork 又和定时快照撞在一起，内存峰值翻倍。

缓解手段：

1. 主库保留 `save` 但把触发条件放宽，避免和业务高峰重合；
2. **从库**开启 `repl-diskless-sync yes` + `repl-diskless-sync-delay 5`，减少磁盘往返；
3. 给主库留够 1.5 倍内存余量，或用 `maxmemory` 卡住但不设 `maxmemory-policy allkeys-lru`（会误删数据）；
4. 大实例拆成多实例，把单次 fork 的内存规模降下来。

## 五、备份这件事，只有验证过才算有

```bash
# 手工触发一次并等待完成
redis-cli bgrewriteaof
redis-cli info persistence | grep -E "aof_rewrite_in_progress|aof_last_bgrewrite_status"

# 备份产物同时保留 RDB 与 AOF
cp /var/lib/redis/appendonlydir/* /backup/redis/$(date +%F)/
```

三条验收标准：

1. **能在另一台机器上恢复**——只备份不演练，等于没有备份；
2. **恢复耗时可知**——10GB AOF 重放可能要几分钟，RTO 得写进预案；
3. **校验数据量**——恢复后 `dbsize` 与备份时刻的 `dbsize` 差值在可接受范围。

## 六、选型速查

| 场景 | 建议 |
| --- | --- |
| 纯缓存，能接受冷启动回源 | 关持久化，`maxmemory` + LRU，恢复靠回源 |
| 会话/队列，丢几秒可接受 | 混合持久化，`everysec` |
| 计费/订单辅助存储 | AOF `always` + 定期 RDB 冷备 + 应用层幂等 |
| 大规模实例（>32GB） | 拆实例，关自动 RDB，用 AOF + 定时外部快照 |

> 一句经验：**先把"能丢多少数据"写成一句话，再选持久化模式**。反过来做——先开最安全的模式再看性能——通常会在压测时把结论推翻，然后回到原点。
