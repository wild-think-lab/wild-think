---
title: 缓存设计：什么时候该缓存，什么时候缓存是毒药
description: 浏览器/CDN/应用/数据库四层缓存怎么分工、Cache-Control 的六个关键指令、缓存三大经典问题与解法、一致性怎么保证。
date: 2026-11-27
tags: [缓存, CDN, Redis, 性能, HTTP]
---

### 缓存的价值只有一个：减少"重复计算"

如果一个请求每次都要查库、聚合、渲染，而其中 90% 的输入是相同的，那就有缓存空间。反之，如果每次结果都不同（个性化推荐、实时余额），缓存只会制造错误。

判断顺序：

1. 这份数据**读远多于写**吗？
2. 能接受**多大程度的过期**（1 秒？1 分钟？1 天？）？
3. 数据量能放进内存/CDN 吗？

三条都过，才谈缓存。

### 四层缓存，各管一段

| 层 | 介质 | 典型 TTL | 失效方式 |
| --- | --- | --- | --- |
| 浏览器 | 本地磁盘/内存 | 分钟级到天级 | `Cache-Control`、文件指纹 |
| CDN | 边缘节点 | 分钟到小时 | purge API、版本化路径 |
| 应用内 | 进程内存（本地缓存） | 秒级 | 定时刷新、事件通知 |
| 分布式 | Redis/Memcached | 分钟到小时 | 主动删 key、TTL |

**就近原则**：越靠前的缓存收益越大（省网络、省 IO），但一致性越难保证。所以静态资源尽量往前放，业务数据往后放。

### HTTP 缓存：六个指令

```
Cache-Control: public, max-age=31536000, immutable     # 带指纹的静态文件
Cache-Control: no-cache                                 # 可缓存但每次要校验
Cache-Control: no-store                                 # 完全不缓存（含敏感数据）
ETag: "abc123"                                          # 协商缓存标识
Last-Modified: Wed, 21 Oct 2026 07:28:00 GMT
Vary: Accept-Encoding, Accept-Language                  # 按维度区分缓存
```

要点：

- `immutable` 配 `max-age=1y` 用于 `app.a1b2c3.js` 这类带哈希的文件，能彻底消除重复请求。
- HTML 入口文件用 `no-cache`（可缓存但每次校验），否则用户永远拿不到新版本。
- API 响应默认 `no-store`，除非明确可缓存。
- `Vary` 漏了 `Accept-Encoding` 会导致 gzip 与原文互相覆盖。

### 缓存三大经典问题

**① 穿透**：查不存在的数据，每次都打到 DB。
解法：缓存空值（TTL 短，如 60s），或用布隆过滤器先拦。

```python
val = redis.get(key)
if val == "__NULL__":
    return None
if val is None:
    row = db.query(key)
    redis.setex(key, 60 if row is None else 300, "__NULL__" if row is None else dump(row))
```

**② 击穿**：热点 key 过期瞬间，大量请求同时回源。
解法：互斥锁（singleflight），同一个 key 只允许一个请求去查库。

```go
v, err, _ := group.Do(key, func() (any, error) { return loadFromDB(key) })
```

**③ 雪崩**：大量 key 同时过期，或缓存集群整体挂掉。
解法：

- TTL 加随机抖动（`base + rand(0, 300s)`）；
- 缓存集群做多副本/多可用区；
- 应用侧加降级开关与限流，保护 DB 不被击穿。

### 一致性：三种更新策略

**Cache Aside（最常用）**：

```
读：缓存命中 → 返回；未命中 → 查库 → 回填
写：更新库 → 删缓存（不是改缓存）
```

为什么删而不是改？并发写时"改缓存"会写入旧值，而"删缓存"让下一次读自然回填正确值。

**先删缓存再更新库**仍有窗口：删缓存后、库更新前，有读请求回填了旧值。缓解办法是"延迟双删"（更新库后 sleep 一小段再删一次），但根本上还是靠 TTL 兜底。

**订阅 binlog 异步失效**（Canal/Debezium）：一致性最好，代价是要多一套组件。数据量大且对一致性敏感时值得。

### 缓存该放什么、不该放什么

适合：

- 配置、字典、地区列表（变化极少）
- 商品详情、文章正文（读远多于写）
- 会话、权限快照（短 TTL）
- 计算结果（排行榜、聚合统计）

不适合：

- 余额、库存（必须先保证正确，缓存只能做"展示层近似"）
- 强事务中间状态
- 大对象（一个 key 几十 MB 会拖慢整个 Redis 实例）

### Redis 用得对不对，看这四个指标

```bash
redis-cli info stats | grep -E 'keyspace_hits|keyspace_misses'
redis-cli info memory | grep used_memory_human
redis-cli info clients | grep connected_clients
redis-cli --bigkeys
```

- 命中率 < 80%：缓存策略或 key 设计有问题。
- `used_memory` 接近 `maxmemory`：开始频繁淘汰，命中率会掉。
- 大 key：`--bigkeys` 会列出来，超过 10MB 的必须拆。
- 连接数暴涨：客户端没复用连接池。

### 一个真实的取舍例子

"首页热门文章列表"：

- 直接查库：每次 20ms，QPS 2000 → DB 压力 4 万行/秒扫描。
- 缓存 60 秒：命中率 99%，DB 压力降到 1/100。
- 代价：新文章最多晚 60 秒出现。

如果业务能接受 60 秒延迟，这就是最划算的方案；如果不能，就得"发布时主动失效 + 短 TTL 兜底"。

### 一句话总结

缓存的本质是**用一致性换性能**。先想清楚"能容忍多久的旧数据"，再决定缓存放哪、TTL 多长、怎么失效。
