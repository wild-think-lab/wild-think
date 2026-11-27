---
title: 部署 PostgreSQL 高可用：Patroni + etcd
module: 进阶篇
summary: 一主两从 + etcd 仲裁、Patroni 自动切换、HAProxy 读写分离，五个"切换了但应用还是连旧主"的原因。
minutes: 50
---

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
