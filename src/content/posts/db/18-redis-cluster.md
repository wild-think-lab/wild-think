---
title: Redis Cluster 运维：分片、故障转移与"半数原则"
description: 16384 槽的意义、集群故障转移的条件、扩容与缩容的实操、以及五个把集群搞挂的操作。
date: 2024-12-26
tags: [Redis, 集群, 运维]
---

### 为什么是 16384 个槽

```
CRC16(key) mod 16384 = 槽号
每个节点负责一段槽
```

**为什么不是 65536**：

```
① 槽数影响"槽位图"（bitmap）大小与 gossip 消息体积
② 16384 在 1000 节点规模下刚好平衡（消息开销可接受）
```

**关键结论：槽数量固定，节点数可变**。加节点 = 重新分配槽。

### 槽与 key 的关系

```bash
# 查 key 属于哪个槽
redis-cli -c -p 7000 cluster keyslot user:1001

# 查槽分布
redis-cli -p 7000 cluster slots
```

**跨槽操作会失败**：

```
MGET user:1 user:2       # 如果不在同一槽 → CROSSSLOT 错误
```

**解决：用 hash tag** 让相关 key 落在同一槽：

```
user:{1001}:name
user:{1001}:profile
# 花括号内的内容参与 hash → 1001 相同 → 同槽
```

**这是一个非常实用的设计约定**：需要一起操作的 key 加相同的 hash tag。

### 集群的最小规模

```
最少 3 主 3 从（6 节点）
原因：故障转移需要"多数派投票"（majority）
3 主：挂 1 主还有 2 主，能选出新主
```

**如果只有 2 主 2 从**：

```
挂 1 主 → 剩 1 主，无法达到多数派（2/4）
→ 集群无法转移 → 该主的数据不可用
```

**这就是"半数原则"**：**存活的 master 必须超过总数的一半**。

### 故障转移的条件

```
① master 挂了（或无法被 ping 到）
② 它的 slave 竞争成为新 master
③ 需要"多数 master"同意（cluster-node-timeout 后判定）
④ 新 master 接管槽，其他节点更新槽映射
```

关键参数：

```conf
cluster-node-timeout 15000        # 多久没响应算挂（默认 15s）
cluster-replica-validity-factor 10
cluster-migration-barrier 1
```

**`cluster-node-timeout` 的取舍**：

```
太小 → 网络抖动就触发转移（频繁切换）
太大 → 真挂了要等很久才转移
```

**建议：内网 5–10 秒，跨机房 15–30 秒**。

### 扩容（加节点）

```bash
# 1. 起新节点（空配置，指定 cluster-enabled yes）
redis-server /etc/redis/7005.conf
redis-server /etc/redis/7006.conf    # 从节点

# 2. 加入集群（作为 master）
redis-cli --cluster add-node 10.0.0.5:7005 10.0.0.1:7000

# 3. 给它分配槽（从现有节点迁移）
redis-cli --cluster reshard 10.0.0.1:7000
# 会交互式问：迁移多少槽、目标节点 ID、从哪些源节点迁

# 4. 加从节点（跟随新 master）
redis-cli --cluster add-node 10.0.0.6:7006 10.0.0.1:7000 \
  --cluster-slave --cluster-master-id <新master-id>
```

**reshard 的过程是"在线迁移"**：

```
① 目标节点与源节点建立连接
② 逐个 key 迁移（MIGRATE 命令）
③ 槽整体转移
```

**迁移大量 key 会占用带宽与 CPU**，建议在低峰做，并限制速度：

```bash
redis-cli --cluster reshard ... --cluster-pipeline 10 --cluster-timeout 5000
```

### 缩容（摘节点）

```bash
# 1. 先把它的槽全部迁走
redis-cli --cluster reshard 10.0.0.1:7000 \
  --cluster-from <要摘的node-id> \
  --cluster-to <接收的node-id> \
  --cluster-slots <槽数> \
  --cluster-yes

# 2. 确认它的槽为 0
redis-cli -p 7005 cluster nodes | grep <node-id>

# 3. 删除节点
redis-cli --cluster del-node 10.0.0.1:7000 <node-id>
```

**顺序不能反**：直接 del-node 会留下"孤儿槽"，集群报错。

### 五个把集群搞挂的操作

**① 没有 hash tag 的批量操作**

```
KEYS user:*         # 会打到所有节点，且阻塞
→ 用 SCAN 遍历，或按槽分别查
```

**② 单节点内存差异过大**

```
某个节点 90% 内存 → 它的 key 被 evict → 业务数据随机丢失
→ 槽分布要均匀，且监控单节点内存
```

**③ 大 key / 热 key**

```
一个 key 有 100 万成员（大 key）→ 迁移时卡住、删除时阻塞
一个 key 每秒 10 万次访问（热 key）→ 单个节点 CPU 打满
```

对策：拆分（大 key 分片、热 key 加本地缓存）。

**④ 全量重启**

```
所有节点同时重启 → 集群丢失多数派 → 无法选出主
→ 逐个重启（一次一个，等集群恢复 HEALTHY）
```

**⑤ 混用单机与集群客户端**

```
用单机客户端连集群 → MOVED 重定向错误
→ 必须用支持 cluster 的客户端（redis-cli -c）
```

### 监控要看什么

```bash
redis-cli -p 7000 cluster info
# cluster_state:ok            ← 必须是 ok
# cluster_slots_assigned:16384 ← 必须全部覆盖
# cluster_known_nodes:6
# cluster_size:3              ← master 数

redis-cli -p 7000 cluster nodes
# 每个节点后跟的 flags：myself, master, slave, fail?, handshake
```

**四个健康判据**：

```
① cluster_state = ok
② cluster_slots_assigned = 16384
③ 每个 master 至少 1 个 slave
④ 没有 fail 标记的节点
```

**`cluster_state:fail` 的两个原因**：

```
- 有槽未分配（16384 覆盖率不足）
- 存活 master 不足多数派
```

### 检查清单

```
□ 至少 3 主 3 从
□ cluster-node-timeout 按网络调整
□ 需要一起操作的 key 用 hash tag
□ 不用 KEYS，用 SCAN
□ 监控单节点内存与槽分布均匀性
□ 拆大 key、防热 key
□ 重启逐个来（不批量重启）
□ 客户端支持 cluster 模式
□ 扩容/缩容都先迁槽再增删节点
□ cluster_state=ok 且槽全覆盖
```
