---
title: Redis 运维速查
summary: 连接与信息、内存与淘汰、慢查询与阻塞、主从与哨兵、集群与常见告警，一页覆盖日常 80% 的操作。
group: 数据
order: 3
tags: [redis, 缓存, 运维]
---

## 一、连接与基本信息

```bash
redis-cli -h 127.0.0.1 -p 6379 -a 'pass' --no-auth-warning
redis-cli INFO server | grep -E 'redis_version|uptime_in_days'
redis-cli INFO clients | grep connected_clients
redis-cli INFO keyspace                 # 各库 key 数量
redis-cli DBSIZE
redis-cli --scan --pattern 'user:*' | head   # 不要用 KEYS（会阻塞）
```

## 二、内存与淘汰

```bash
redis-cli INFO memory | grep -E 'used_memory_human|maxmemory_human|mem_fragmentation_ratio'
redis-cli CONFIG GET maxmemory-policy
redis-cli --bigkeys                     # 找大 key（会扫全库，低峰期跑）
redis-cli MEMORY USAGE <key>
```

淘汰策略选择：

| 策略 | 行为 | 适用 |
| --- | --- | --- |
| `noeviction` | 内存满则写报错 | **不能丢数据**（当 DB 用） |
| `allkeys-lru` | 所有 key 按 LRU 淘汰 | 纯缓存（最常用） |
| `volatile-lru` | 只淘汰设了过期时间的 | 混合用途 |
| `allkeys-lfu` | 按访问频率 | 热点明显 |
| `volatile-ttl` | 优先淘汰将要过期的 | 特殊场景 |

```bash
redis-cli CONFIG SET maxmemory 4gb
redis-cli CONFIG SET maxmemory-policy allkeys-lru
redis-cli CONFIG REWRITE          # 落盘到配置文件
```

**碎片率** `mem_fragmentation_ratio > 1.5` 考虑开启 `activedefrag` 或重启。

## 三、慢查询与阻塞

```bash
redis-cli CONFIG SET slowlog-log-slower-than 10000   # 10ms
redis-cli SLOWLOG GET 10
redis-cli SLOWLOG RESET

redis-cli INFO commandstats | sort -t: -k3 -r | head   # 命令耗时统计
redis-cli CLIENT LIST                   # 谁在连着、在跑什么
redis-cli CLIENT KILL ID <id>
```

常见阻塞原因：

```
① KEYS * / FLUSHALL / FLUSHDB 大库
② 大 key 的 DEL（用 UNLINK 异步删）
③ 大 key 的 HGETALL / SMEMBERS
④ Lua 脚本里跑长循环
⑤ AOF rewrite / RDB fork 时的瞬时卡顿
⑥ swap 被使用（内存不足）
```

**删大 key**：

```bash
redis-cli UNLINK big:key
# 或分批：SCAN + HDEL
```

## 四、持久化

```bash
redis-cli CONFIG GET save
redis-cli CONFIG GET appendonly
redis-cli BGSAVE
redis-cli BGREWRITEAOF
redis-cli INFO persistence | grep -E 'rdb_|aof_'
```

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| RDB | 文件小、恢复快 | 可能丢最后几分钟 |
| AOF（everysec） | 最多丢 1 秒 | 文件大、恢复慢 |
| 混合（RDB+AOF，7.0+） | 兼顾 | 配置略复杂 |

**生产建议**：主从 + AOF everysec + 定期 RDB 备份到对象存储。

## 五、主从与哨兵

```bash
redis-cli INFO replication
# role:master / connected_slaves:2 / master_link_status:up
```

从库只读：

```bash
redis-cli CONFIG SET replica-read-only yes
```

哨兵：

```bash
redis-cli -p 26379 SENTINEL masters
redis-cli -p 26379 SENTINEL slaves mymaster
redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster
redis-cli -p 26379 SENTINEL failover mymaster      # 手动切换
```

**哨兵至少 3 个且为奇数**（quorum 需要多数派）。

## 六、集群

```bash
redis-cli -c -p 7000 CLUSTER INFO
redis-cli -c -p 7000 CLUSTER NODES
redis-cli -c -p 7000 CLUSTER SLOTS
redis-cli --cluster check 10.0.0.10:7000
redis-cli --cluster reshard 10.0.0.10:7000
redis-cli --cluster add-node <new>:7003 <existing>:7000
```

**集群模式注意**：

- 多 key 操作要求同一 slot（用 hash tag `{user1}:a`、`{user1}:b`）。
- `-c` 参数才能自动跟随重定向。
- 集群不支持 `SELECT` 多库（只有 db0）。

## 七、常见告警与处置

| 告警 | 含义 | 处置 |
| --- | --- | --- |
| `used_memory > 80% maxmemory` | 快满 | 扩容 / 调淘汰策略 / 清大 key |
| `evicted_keys` 快速上升 | 一直在淘汰 | 扩容或降低写入 |
| `blocked_clients > 0` 持续 | 有阻塞命令 | 查 slowlog / CLIENT LIST |
| `rejected_connections` | 连接数打满 | 调 `maxclients`、查连接泄漏 |
| `master_link_status:down` | 主从断了 | 查网络、`requirepass` 一致性 |
| `rdb_last_bgsave_status:err` | 持久化失败 | 查磁盘空间与权限 |

## 八、安全与配置

```bash
# 必做三件
CONFIG SET requirepass 'StrongPass'
CONFIG SET rename-command FLUSHALL ""        # 禁用危险命令（需重启生效）
# 绑定内网
bind 10.0.0.10 127.0.0.1
protected-mode yes
```

**永远不要把 6379 暴露到公网**：未授权访问是最常见的入侵入口之一。

## 九、一行命令小抄

```bash
redis-cli --latency                     # 延迟基线
redis-cli --latency-history             # 随时间变化
redis-cli --stat                        # 实时统计
redis-cli MONITOR                       # 实时命令流（生产慎用）
redis-cli DEBUG SLEEP 0                 # 检查是否被阻塞
redis-cli MEMORY DOCTOR                 # 内存诊断建议
```
