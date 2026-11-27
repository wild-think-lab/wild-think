---
title: Ceph 出问题时先看什么（PG 不干净、OSD down）
description: 四个最常见故障的排查顺序、为什么"先等 ISR 收敛"比"立刻删 OSD"重要、以及限流避免业务被拖死。
date: 2024-03-26
tags: [Ceph, 存储, 排错, 分布式]
---

### 排查的固定顺序

```bash
ceph -s                 # 总体状态
ceph health detail      # 具体原因
ceph osd tree           # 谁是 up 谁是 in
ceph pg stat            # PG 分布
```

**不要一上来就 `ceph osd out`**：那会触发数据重平衡，可能让本来就紧张的环境雪上加霜。

### 常见故障一：OSD down 但 in

```bash
ceph osd tree
# 10  hdd  1.00000  osd.10  down  1.0   ← down 且 in=1
```

**含义**：

```
down：OSD 进程不可达（网络/进程/磁盘）
in  ：仍然参与数据分布
```

**危险**：如果是"短暂网络抖动"，很快会恢复；如果长时间 down，PG 会 degraded，其他 OSD 承担更多。

**排查**：

```bash
# 1. OSD 进程在吗
systemctl status ceph-osd@10
journalctl -u ceph-osd@10 -n 30

# 2. 节点网络
ceph osd metadata 10 | grep -E "hostname|front_addr"

# 3. 磁盘健康
smartctl -a /dev/sdX | grep -E "Reallocated|Pending|Health"
```

**处理**：

```
① 进程挂了 → 重启，看日志
② 磁盘坏 → 换盘（同 OSD ID 重建）
③ 网络抖动 → 等恢复（同时把 backfill 限速）
④ 节点彻底坏了 → 先在 CRUSH 里标记 out（谨慎），再换机
```

### 常见故障二：PG 一直 degraded

```bash
ceph pg stat
# 1000 pgs: 960 active+clean, 40 active+degraded
```

**含义**：有 PG 的副本数不足（3 副本只剩 2）。

**何时可等**：

```
① OSD 只是短暂 down → 等它回来（PG 会自动恢复）
② 正在 backfill → 看恢复速率
```

```bash
ceph -s | grep -A4 recovery
# 看 io/sec 与预计完成时间
```

**何时要动手**：

```
① 有 OSD 永久丢失（磁盘坏且不修）
   → 标记 out，让数据在其他 OSD 上重建
② backfill 卡住（长时间不推进）
   → 查网络、查目标 OSD 是否快满
```

### 常见故障三：backfill 把业务拖死

**现象**：

```
业务读延迟飙升，同时 ceph -s 显示大量 backfilling
```

**原因**：恢复流量抢占了业务 IO。

**限流（这是必需的）**：

```bash
# 降低同时恢复的 PG 数与每 OSD 的 backfill 数
ceph config set osd osd_max_backfills 1
ceph config set osd osd_recovery_max_active 1
ceph config set osd osd_recovery_sleep 0.1

# 让业务 IO 优先
ceph config set osd osd_client_op_priority 63
ceph config set osd osd_recovery_op_priority 40
```

**更细的控制（按时间段）**：

```bash
# 白天限死，晚上放开
# 用 cron 切换
0 8 * * * ceph config set osd osd_max_backfills 1
0 22 * * * ceph config set osd osd_max_backfills 8
```

### 常见故障四：OSD 快满（nearfull / full）

```bash
ceph osd df tree
# 单 OSD 到 85%（nearfull）→ 开始告警
# 到 95%（full）→ 该 OSD 停止写入
```

**"一个 OSD 满，整个集群写不进去"的原因**：

```
CRUSH 决定了某个 PG 的副本落在哪些 OSD
如果其中一个 OSD 满，那个 PG 就写不进
→ 该 PG 上的业务报错
```

**处理（按优先级）**：

```
① 临时：把满的 OSD weight 调低（让数据迁走）
   ceph osd reweight 12 0.9

② 中期：加 OSD / 加盘（扩容）
③ 长期：调整 CRUSH 让分布均匀，或调 full ratio（不推荐）
```

**监控**：

```bash
# 每个 OSD 的使用率
ceph osd df | awk 'NR>1 {print $1, $2, $NF}'
# 或看 ceph osd df tree 的 %USE 列
```

### 常见故障五：时钟偏移（clock skew）

```
ceph health detail: clock skew detected on mon.x, mon.y
```

**原因**：MON 之间时间不同步（> 0.05s）。

**处理**：

```bash
timedatectl status
chronyc sources -v
chronyc tracking     # 看 System time 偏差
```

**Ceph 对时间敏感**：MON 的 Paxos 依赖时间戳。

**建议**：全集群统一 chrony 指向同一上游，且 `makestep` 允许大幅纠正。

### 常见故障六：pool 的 PG 数不合理

```bash
ceph health detail
# too many PGs per OSD (312 > max 250)
```

**为什么重要**：

```
PG 太多 → 每个 OSD 要维护大量 PG 状态 → 内存与 CPU 压力大 → 性能下降
```

**计算**：

```
PG 总数 ≈ (OSD 数 × 100) / 副本数
每 OSD 的 PG 数 ≈ PG 总数 × 副本数 / OSD 数
```

**处理**：

```
① 减少不必要的 pool（合并或删除）
② 调小 pool 的 pg_num（只能减不能随便减，需要工具）
③ 加 OSD（分散 PG）
```

**注意**：`pg_num` 只能"增大"（在线），减小需要 `ceph osd pool set <pool> pg_num` 配合 `pgp_num` 与新工具，风险高。

### 一个"全集群慢"的排查表

| 检查项 | 命令 | 判据 |
| --- | --- | --- |
| 整体健康 | `ceph -s` | 有无 HEALTH_WARN/ERR |
| 恢复流量 | `ceph -s \| grep recovery` | 是否有大量 backfill |
| OSD 负载 | `ceph osd perf` | 各 OSD 的 apply/commit 延迟 |
| 网络 | `ceph osd perf` 的延迟突增 | 是否有网络问题 |
| 磁盘 | `iostat -x 1` | await 与 %util |
| PG 分布 | `ceph pg stat` | 是否有 stuck PG |
| 客户端 | 客户端 `rbd`/`cephfs` 的延迟 | 是客户端侧还是集群侧 |

**`ceph osd perf` 非常有用**：

```bash
ceph osd perf
# osd  fs_commit_latency(ms)  fs_apply_latency(ms)
#  10                    2.1                  1.8
#  11                   25.0                 18.0    ← 明显异常
```

**某个 OSD 延迟远高于其他** → 那块盘/那个节点有问题。

### 检查清单

```
□ 故障先看 ceph -s + health detail（不盲目操作）
□ OSD down 先查进程/磁盘/网络，再决定是否 out
□ 恢复期一定限流（backfill/recovery 参数）
□ 业务 IO 优先级高于恢复
□ 监控单 OSD 使用率（85% 预警）
□ 发生 nearfull 先 reweight 再扩容
□ 时钟统一（chrony）
□ 每 OSD 的 PG 数 < 200
□ 用 ceph osd perf 找异常 OSD
□ 有 runbook（含"先等 ISR 收敛"这一条）
```
