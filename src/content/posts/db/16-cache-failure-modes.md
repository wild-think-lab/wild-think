---
title: 缓存穿透、击穿、雪崩：三种"缓存出事"的区别与解法
description: 三种失效模式的现象与根因、布隆过滤器与空值缓存、互斥锁重建、随机过期与多级缓存，以及怎么判断自己在防哪一种。
date: 2026-11-27
tags: [缓存, Redis, 高并发]
---

### 一句话区分

```
穿透：查一个"不存在"的数据 → 每次都打到数据库
击穿：一个"热点 key"过期 → 大量请求同时重建
雪崩：大量 key 同时过期 / 缓存整体挂了 → 数据库被打垮
```

**记忆法**：穿透是"数据不存在"，击穿是"一个热点没了"，雪崩是"一片同时没了"。

### 穿透：查不存在的数据

**现象**：数据库 QPS 很高，但查的都是"不存在的 ID"（如 `id=-1`、随机 ID）。

**根因**：缓存里没有（因为数据本身不存在），所以每次都穿透到 DB。

**解法一：缓存空值**

```python
def get_user(uid):
    key = f"user:{uid}"
    val = redis.get(key)
    if val == "__NULL__":
        return None
    if val is not None:
        return json.loads(val)

    user = db.query_user(uid)
    if user is None:
        redis.setex(key, 60, "__NULL__")     # 短 TTL，防长期脏数据
        return None
    redis.setex(key, 3600, json.dumps(user))
    return user
```

**注意**：空值 TTL 要短（60s 左右），否则新增数据后会被"空值"挡住。

**解法二：布隆过滤器**

```python
# 启动时把所有存在的 ID 灌进去
bf = BloomFilter(capacity=10_000_000, error_rate=0.001)
for uid in db.all_user_ids():
    bf.add(uid)

def get_user(uid):
    if uid not in bf:          # 一定不存在
        return None
    # 可能存在（有假阳性），继续查缓存/DB
```

**代价**：假阳性（说存在但实际不存在），且删除困难（布隆过滤器不支持删）。

**解法三：参数校验**

```
最省事的一层：接口层直接拒绝非法参数
- ID 必须为正整数
- ID 超过合理范围（如 > 1e12）直接拒
```

### 击穿：一个热点 key 过期

**现象**：某个爆款商品的详情页，key 过期那一瞬间，几百个请求同时打到 DB。

**解法一：互斥锁重建（最常用）**

```python
def get_hot(key, rebuild_fn):
    val = redis.get(key)
    if val is not None:
        return json.loads(val)

    lock_key = f"lock:{key}"
    # SET NX EX：只有一个请求能拿到锁
    if redis.set(lock_key, "1", nx=True, ex=10):
        try:
            data = rebuild_fn()
            redis.setex(key, 300, json.dumps(data))
            return data
        finally:
            redis.delete(lock_key)
    else:
        # 没拿到锁：短睡眠后重试（或返回旧值/降级）
        time.sleep(0.05)
        return get_hot(key, rebuild_fn)
```

**要点**：锁要有过期时间（防死锁）；拿不到锁的请求要"短暂等待再重试"，不要直接打到 DB。

**解法二：逻辑过期（永不真正过期）**

```python
# 存的是 {data, expire_at}，key 本身不设 TTL
def get_hot(key, rebuild_fn):
    raw = redis.get(key)
    if raw is None:
        return rebuild_and_set(key, rebuild_fn)
    obj = json.loads(raw)
    if obj["expire_at"] > time.time():
        return obj["data"]
    # 已逻辑过期：异步重建，先返回旧值
    async_rebuild(key, rebuild_fn)
    return obj["data"]
```

**好处**：用户永远拿到数据（可能稍旧），没有等待。

**解法三：热点 key 不设过期**

```
对"确定会一直热"的数据（如首页配置），直接不设 TTL
靠主动更新（发版/事件触发时刷新）
```

### 雪崩：一片同时没了

**诱因**：

```
① 大量 key 用了相同的过期时间（如都是"缓存 1 小时"）
② Redis 实例挂了
③ 缓存集群重启
```

**解法一：过期时间加随机**

```python
ttl = base_ttl + random.randint(0, 300)    # 1 小时 ± 5 分钟
```

**这是最便宜、最有效的一招**，几乎必须做。

**解法二：多级缓存**

```
本地缓存（进程内，如 Caffeine）→ Redis → DB
Redis 挂了，本地缓存还能挡一部分
```

代价：一致性变差（本地缓存更新有延迟）；适合"读多写少、容忍短暂不一致"的数据。

**解法三：限流与降级**

```
缓存不可用时：
- 对 DB 的访问加限流（如 500 QPS）
- 超出部分返回降级页/默认值
```

**宁可返回旧数据或"稍后再试"，也不要让 DB 被打死**。

**解法四：Redis 高可用**

```
主从 + Sentinel 或 Cluster
关键：故障切换期间要有"本地缓存/限流"兜底
```

### 怎么判断自己在防哪一种

```
查"不存在的数据"多 → 穿透
某个热点 key 过期瞬间 QPS 尖刺 → 击穿
某个时间点整体 QPS 暴涨 → 雪崩（过期时间集中）
Redis 挂掉后 DB 立刻打死 → 雪崩（无兜底）
```

**看监控的三个信号**：

```
① DB QPS 的形态（尖刺 / 持续高 / 整体暴涨）
② 缓存命中率（突降 = 有 key 大批失效）
③ 请求的 key 分布（大量不存在的 key = 穿透）
```

### 常见误用

```
❌ 只缓存"存在"的数据，不缓存空值 → 穿透
❌ 所有 key 固定 TTL → 雪崩
❌ 用"删除缓存"而不是"更新缓存" → 并发下不一致
❌ 缓存与 DB 双写没有顺序保证 → 脏数据
❌ 没有兜底（缓存挂了直接打 DB）
```

**缓存与 DB 的一致性**：

```
推荐：先更新 DB，再删除缓存（Cache-Aside）
可接受短暂不一致的场景：延迟双删（更新后删一次，500ms 再删一次）
绝对强一致：不要用缓存
```

### 检查清单

```
□ 空值缓存（短 TTL）或布隆过滤器
□ 接口层参数校验
□ 热点 key 用互斥锁重建或逻辑过期
□ 所有 TTL 加随机偏移
□ 有本地缓存或限流兜底
□ Redis 有高可用（Sentinel/Cluster）
□ 监控命中率与 DB QPS 形态
□ 更新策略明确（DB 先写，再删缓存）
```
