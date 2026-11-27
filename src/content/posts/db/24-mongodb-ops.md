---
title: MongoDB 运维：副本集、索引与"为什么查询越来越慢"
description: 副本集角色与选举、写关注、索引策略、分片键选择，以及五个让 Mongo 变慢的常见原因。
date: 2026-01-20
tags: [MongoDB, 数据库, 运维]
---

### 副本集的最小结构

```
Primary   ：唯一接受写
Secondary ：复制数据，可读（需设置 readPreference）
Arbiter   ：只投票不存数据（不推荐用于生产，会造成脑裂风险）
```

**至少 3 个投票成员**，否则无法形成多数。

```yaml
# 三节点是最小可用配置
rs0:PRIMARY> rs.status()
```

### 选举与脑裂

```
需要"多数"（N/2 + 1）才能选出 Primary
3 节点 → 需要 2 票
5 节点 → 需要 3 票
```

**两种经典错误**：

```
① 2 节点副本集（+1 arbiter）→ arbiter 挂了就无法选主
② 跨机房放置不当 → 主备来回切
```

**跨机房原则**：

```
两个机房各若干节点，第三个"仲裁"放在第三方机房
或：主 + 2 备全在一个机房，异地做 DR（异步）
```

### 写关注（writeConcern）

```javascript
db.orders.insertOne(doc, { writeConcern: { w: "majority", j: true, wtimeout: 5000 } })
```

**三个参数**：

```
w        ：确认写入了几个节点（"majority" 最安全；"1" 最快）
j        ：是否等落盘（true = 写日志后才确认）
wtimeout ：等多久算超时（超时不代表写失败！）
```

**`wtimeout` 的坑**：

```
超时了但服务端可能已经写成功
→ 客户端不能简单重试（可能重复插入）
→ 要用幂等键
```

**推荐配置**：

```
关键业务：w: "majority", j: true
日志/可丢数据：w: 1（快）
```

### 读偏好（readPreference）

```javascript
db.orders.find().readPref("secondaryPreferred")
```

**五种模式**：

```
primary              ：只读主（默认，强一致）
primaryPreferred     ：优先主，主不可用时读从
secondary            ：只读从（可能读到旧数据）
secondaryPreferred   ：优先从
nearest              ：读延迟最低的节点
```

**"读从库"的代价**：

```
复制延迟期间读到旧数据（业务逻辑可能出错）
→ 涉及"读自己刚写的"场景必须读主
```

### 索引策略

**MongoDB 的索引与 MySQL 思路类似但细节不同**：

```javascript
// 单字段
db.orders.createIndex({ userId: 1 })

// 复合（顺序很重要）
db.orders.createIndex({ userId: 1, createdAt: -1 })

// 唯一
db.users.createIndex({ email: 1 }, { unique: true })

// 部分索引（只索引符合条件的文档）
db.orders.createIndex(
  { status: 1 },
  { partialFilterExpression: { status: "active" } }
)

// TTL（自动过期删除）
db.sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 })

// 文本搜索
db.posts.createIndex({ title: "text", body: "text" })
```

**复合索引的规则**：

```
① ESR 原则：Equality → Sort → Range
② 顺序错了就无法高效利用
③ 一个复合索引能覆盖多种查询（前缀匹配）
```

**例**：

```javascript
// 查询：status = 'paid' AND createdAt > ... ORDER BY createdAt DESC
// 正确：{ status: 1, createdAt: -1 }
// 错误：{ createdAt: -1, status: 1 }   ← range 在前，后面的字段用不上
```

### 五个让 Mongo 变慢的原因

**① 没有索引 / 索引没被用上**

```javascript
db.orders.find({...}).explain("executionStats")
// 看 "totalDocsExamined" 与 "nReturned" 的比值
// 如果 examined >> returned → 全表扫
```

**"explain" 是排查的第一步**。

**② 文档太大 / 数组无限增长**

```
单个文档上限 16MB
数组字段持续 push → 文档不断变大 → 频繁移动 → 写放大
```

**处理**：

```
① 拆分成独立集合
② 用 $slice 限制数组长度（push + $slice: -100）
③ 大字段评估是否该存对象存储
```

**③ 索引太多**

```
每个索引都要在写入时维护
→ 写慢、内存占用高
```

**检查**：

```javascript
db.orders.getIndexes()
db.orders.aggregate([{ $indexStats: {} }])
// 看 "accesses.ops" = 0 的索引 → 可以删
```

**④ 分片键选错**

```
差的分片键：
① 单调递增（如 ObjectId、时间戳）→ 所有写入落在一个分片（热点）
② 基数太低（如 status）→ 无法均匀分布
③ 频繁更新（如 lastLogin）→ 文档不断迁移
```

**好的分片键**：

```
① 高基数（userId、orderId 的 hash）
② 写入能均匀分布（用 hashed 分片键）
③ 查询常用（避免 scatter-gather）
```

```javascript
sh.shardCollection("app.orders", { userId: "hashed" })
```

**⑤ 连接数爆炸**

```
每个应用实例建 N 个连接 → 总连接数暴涨 → Mongo 内存与线程压力
```

**检查**：

```javascript
db.serverStatus().connections
```

**处理**：

```
① 应用侧用连接池（有上限）
② 不要每个请求新建连接
```

### 常用运维命令

```javascript
// 状态
rs.status()
db.serverStatus()

// 慢查询（需开 profiling）
db.setProfilingLevel(1, { slowms: 100 })
db.system.profile.find().sort({ ts: -1 }).limit(5)

// 当前操作
db.currentOp({ "secs_running": { $gt: 3 } })
db.killOp(<opid>)

// 集合大小
db.orders.stats()

// 副本集延迟
rs.printSecondaryReplicationInfo()
```

**`rs.printSecondaryReplicationInfo()` 直接显示各从库落后多少秒**，排查"读不到刚写的数据"必看。

### 备份

```bash
# 逻辑备份
mongodump --uri="mongodb://user:pass@host/db" --gzip --archive=/backup/db-$(date +%F).gz

# 恢复
mongorestore --gzip --archive=/backup/db-2026-11-27.gz

# 文件系统快照（副本集下：先 fsyncLock）
```

**注意**：

```
① 副本集下从 Secondary 备份（不压主库）
② fsyncLock 期间该节点不可写（要从负载摘掉）
③ 备份要验证能恢复（定期演练）
```

### 安全基线

```yaml
# mongod.conf
security:
  authorization: enabled
  keyFile: /etc/mongo/keyfile    # 副本集内部认证

net:
  bindIp: 127.0.0.1,10.0.0.5     # 不要 0.0.0.0
  port: 27017
```

**必做**：

```
① 开启 authorization（默认是关闭的！）
② 建管理员账号 + 各库专用账号（最小权限）
③ 不要暴露公网（很多勒索事件源于暴露的 27017）
④ 副本集用 keyFile 或 x509 内部认证
```

**"MongoDB 暴露公网被勒索"是历史高频事件**。

### 检查清单

```
□ 副本集 ≥ 3 投票成员
□ 跨机房有仲裁/DR 方案
□ 关键写用 w:majority + j:true
□ 幂等处理（应对 wtimeout 重试）
□ 读自己刚写 → 读主
□ 复合索引遵循 ESR
□ explain 检查 examined/returned 比
□ 定期清理无用索引（$indexStats 为 0）
□ 控制文档大小与数组长度
□ 分片键高基数且写入均匀（考虑 hashed）
□ 应用侧连接池有上限
□ 开启 authorization + bindIp 收紧
□ 从 Secondary 备份且演练过恢复
```
