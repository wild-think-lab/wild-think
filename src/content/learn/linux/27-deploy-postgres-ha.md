---
title: 部署 PostgreSQL 高可用：Patroni + etcd
module: 进阶篇
summary: 一主两从 + etcd 仲裁、Patroni 自动切换、HAProxy 读写分离，五个"切换了但应用还是连旧主"的原因。
minutes: 50
---

## 一、先弄懂它是什么

**PostgreSQL 高可用 = 一份数据在多个节点上可读 + 主节点故障能自动接管。** 这里用两个组件分工：

```
Patroni：决定"谁是主"，并负责把从库跟上、把旧主拉回来（进程级 HA 编排）
etcd   ：提供"分布式锁 + 共识"，让多台 Patroni 对"谁是主"达成一致（防脑裂）
```

**它解决的问题**：单机 PostgreSQL 一旦宕机，业务就停；有了 HA，RTO 从"人工恢复几十分钟"变成"自动切换几十秒"。

### 复制原理（必须懂，否则判断不了延迟）

```
主库写 WAL（预写日志）→ 传送到从库 → 从库重放（replay）
同步复制：主库等从库确认再返回（synchronous_commit=on + synchronous_standby_names）
异步复制：主库写完就返回（可能丢最后一段）
```

```
复制延迟 = 从库 replay 落后主库多少字节/秒
→ 延迟大时切换会丢更多数据，也说明从库 IO 跟不上
```

### 为什么需要"仲裁"

```
没有仲裁：两台都认为自己是主 → 双主写入 → 数据分叉（脑裂）
有仲裁：多数派决定谁当主（3 节点容忍 1 台失联）
```

这就是 etcd 必须是**奇数**节点的原因。

### 三个组件的职责边界

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| etcd | 存集群状态、选主投票 | 不存业务数据 |
| Patroni | 选主、promote/demote、pg_rewind、REST 状态 | 不做流量路由 |
| HAProxy | 按 `/primary` 健康检查把写流量只发给主 | 不做选主 |
| 应用 | 连 VIP/HAProxy、带重试 | 不该自己判断主从 |

**判据**：应用连的是"入口"（VIP/HAProxy），不是某台数据库 IP。否则一切自动切换都白做。

### 切换时到底发生了什么

```
① 主库失联 → Patroni 检测（ttl/loop_wait）
② etcd 里 leader key 过期 → 剩余节点竞选
③ 胜者 promote 为 primary（改 pg 状态、更新 REST /primary）
④ HAProxy 健康检查发现新主 → 流量切过去
⑤ 旧主恢复 → pg_rewind 追平 → 变回 replica（不重做全量）
```

### 架构

```
etcd ×3（仲裁，决定谁是主）
Patroni ×3（每台 PostgreSQL 一个，负责选主与复活）
HAProxy（对外统一入口，读主/读从）
```

**为什么需要 etcd**：Patroni 用 DCS 做"谁当主"的共识，避免两台都以为自己是主（脑裂）。

### etcd（三节点）

```bash
ETCD_NAME=etcd1
ETCD_INITIAL_CLUSTER="etcd1=http://10.0.0.51:2380,etcd2=http://10.0.0.52:2380,etcd3=http://10.0.0.53:2380"
ETCD_INITIAL_CLUSTER_STATE=new
```

**验证**：

```bash
etcdctl member list -w table
etcdctl endpoint health --cluster
```

### PostgreSQL 基础（三台一样）

```bash
dnf install -y postgresql16-server postgresql16-contrib
/usr/pgsql-16/bin/postgresql-16-setup initdb
```

```conf
# postgresql.conf
listen_addresses = '*'
wal_level = replica
max_wal_senders = 10
hot_standby = on
```

**注意**：Patroni 会接管启动，不要再用系统自带的 `postgresql-16` 服务。

### Patroni 配置（node1 为例）

```yaml
# /etc/patroni.yml
scope: pg-cluster
namespace: /service/
name: pg1

restapi:
  listen: 10.0.0.51:8008
  connect_address: 10.0.0.51:8008

etcd3:
  hosts: 10.0.0.51:2379,10.0.0.52:2379,10.0.0.53:2379

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    postgresql:
      use_pg_rewind: true
      parameters:
        synchronous_commit: "on"

postgresql:
  listen: 10.0.0.51:5432
  connect_address: 10.0.0.51:5432
  data_dir: /data/pg
  authentication:
    replication: { username: replicator, password: "<pwd>" }
    superuser: { username: postgres, password: "<pwd>" }
```

**`use_pg_rewind: true`** 让旧主能快速回归，不用全量重建。

### 启动与验证

```bash
patronictl -c /etc/patroni.yml list
```

```
+ Cluster: pg-cluster ----+---------+---------+----+-----------+
| Member | Host        | Role    | State   | TL | Lag in MB |
| pg1    | 10.0.0.51   | Leader  | running |  1 |           |
| pg2    | 10.0.0.52   | Replica | running |  1 |         0 |
```

**判据**：一个 Leader、其余 Replica，且 lag 为 0。

### 手动切换（演练必做）

```bash
patronictl -c /etc/patroni.yml switchover --master pg1 --candidate pg2
```

**观察**：应用报错时长、HAProxy 是否跟随、旧主是否变 Replica。

### HAProxy 路由

```conf
listen pg-primary
  bind *:5433
  option httpchk GET /primary
  http-check expect status 200
  default-server inter 3s fall 2 rise 3
  server pg1 10.0.0.51:5432 check port 8008
  server pg2 10.0.0.52:5432 check port 8008
  server pg3 10.0.0.53:5432 check port 8008
```

**原理**：Patroni REST 的 `/primary` 只有主返回 200 → HAProxy 自动只连主。

### 五个"切换了但应用连旧主"

**① 连接串写死 IP**

```
应指向 HAProxy / VIP
```

**② 应用无重试**

```
切换瞬间报错就崩溃
```

**③ 连接池缓存了旧连接**

```
连接池不健康检查 → 一直用死连接
```

**④ 旧主未隔离**

```
它仍是 primary（未 rewined）→ 双主写
```

**⑤ 没演练**

```
真切换时发现 HAProxy 健康检查端口不通
```

### 检查清单

```
□ etcd 三节点健康
□ Patroni 三节点角色清晰
□ `patronictl list` 无 lag
□ 应用连 HAProxy/VIP（不连 IP）
□ 应用有重试与超时
□ 连接池有健康检查
□ 旧主能 pg_rewind 回归
□ 有复制延迟告警
□ 有主切换告警
□ 每季度 switchover 演练
```
