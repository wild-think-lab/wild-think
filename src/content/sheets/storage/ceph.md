---
title: Ceph 速查
summary: 集群部署后的日常检查、OSD/MON/PG 状态判读、常见故障（PG 不干净、OSD down）的处理顺序。
group: Storage
order: 1
tags: [ceph, 存储, 运维]
---

## 一、集群总览

```bash
ceph -s               # 最常用：健康、容量、PG 数、节点数
ceph -w               # 持续观察（Ctrl-C 退出）
ceph health detail    # 有 HEALTH_WARN 时看详细原因
ceph df               # 容量（按 pool）
ceph osd tree         # OSD 拓扑（host → osd）
```

**读 `ceph -s` 的关键三行**：

```
health: HEALTH_OK / HEALTH_WARN / HEALTH_ERR
mon: 3 daemons, quorum a,b,c
osd: 24 up, 24 in
```

**`up` 与 `in` 的区别**：

```
up   ：OSD 进程在跑
in   ：OSD 参与数据分布（in=1 才会接到数据）
osd down 但 in=1 → 会触发数据重平衡（危险）
```

## 二、日常检查（每天一遍）

```bash
ceph -s
ceph health detail
ceph osd df tree           # 每个 OSD 的使用率与 weight
ceph pg stat               # PG 状态分布
```

**判断容量风险**：

```
单个 OSD > 85% → 需要扩容（Ceph 有 near-full(85%) / full(95%) 阈值）
集群平均 > 70% → 规划扩容
```

## 三、PG 状态判读

```bash
ceph pg stat          # 汇总：active+clean 应接近 100%
ceph pg dump_stuck    # 卡住的 PG
ceph pg ls-by-pool <pool>
```

| 状态 | 含义 | 处理 |
| --- | --- | --- |
| active+clean | 正常 | — |
| active+undersized | 副本数不够（OSD 少） | 加 OSD |
| active+degraded | 有副本缺失 | 等恢复或修 OSD |
| remapped+backfilling | 正在迁移 | 等，或限速 |
| inactive | 无主 PG | 检查 OSD/mon 通信 |
| stale | 主 OSD 失联 | 检查网络与 OSD |
| peered | 副本协商中 | 通常短暂 |

**`backfill` 限速**（避免迁移打满网络）：

```bash
ceph tell osd.* injectargs '--osd-max-backfills 1'
ceph config set osd osd_max_backfills 1
ceph config set osd osd_recovery_max_active 3
```

## 四、OSD 故障处理顺序

**① 先看 OSD 状态**

```bash
ceph osd tree
ceph osd stat
systemctl status ceph-osd@<id>
```

**② OSD down 但进程活着**（网络抖动）

```bash
# 若确认是短暂网络问题，可以等
ceph osd safe-to-destroy <id>     # 判断能否安全销毁
```

**③ 真的要摘除 OSD**

```bash
# 第一步：标记 out（触发数据重平衡，加 --yes-i-really-mean-it 才生效于危险操作）
ceph osd out <id>

# 等 PG 恢复（重要！不要在数据未恢复时继续）
ceph -w        # 看 active+clean 回到 100%

# 第二步：停进程
systemctl stop ceph-osd@<id>
ceph osd crush remove osd.<id>
ceph osd rm <id>
ceph auth del osd.<id>
```

**顺序不能反**：先 `out` 等数据迁移完成，再删。直接删会导致数据永久丢失（副本不足）。

**④ 换盘（同一 OSD ID 重用）**

```bash
# 保留 ID：用 ceph-volume 重建
ceph-volume lvm zap /dev/sdX --destroy
ceph-volume lvm prepare --bluestore --data /dev/sdX --osd-id <id>
systemctl start ceph-osd@<id>
```

## 五、常见故障

**① HEALTH_WARN: clock skew**

```
时间不同步
处理：chrony/ntp 全集群统一时间源
```

**② HEALTH_WARN: pgs inconsistent**

```bash
ceph health detail | head
ceph pg repair <pgid>
# 若修复失败，看 scrub 日志
```

**③ HEALTH_WARN: too many PGs per OSD**

```
PG 数 > 200/OSD 会拖慢
处理：减少 pool 的 pg_num，或加 OSD
```

**④ HEALTH_ERR: full osd(s)**

```
某个 OSD 到 95%
处理：立刻扩容或删数据；临时可调 full ratio（危险）
ceph osd set-full-ratio 0.96
```

**⑤ OSD 起不来**

```bash
journalctl -u ceph-osd@<id> -n 50
# 常见：磁盘坏、LVM 元数据丢、蓝屏（bluestore 损坏）
```

## 六、Pool 管理

```bash
ceph osd pool ls detail
ceph osd pool create mypool 128 128          # pg_num / pgp_num
ceph osd pool set mypool size 3
ceph osd pool set mypool min_size 2

# 应用标签（必须打，否则集群会告警）
ceph osd pool application enable mypool rbd
```

**PG 数速算**：

```
PG 总数 ≈ (OSD 数 × 100) / 副本数
每个 pool 的 pg_num 取 2 的幂
```

例：24 OSD，副本 3 → 总数约 800 → 每个 pool 128 或 256。

## 七、RBD（块存储）

```bash
rbd create mypool/vol1 --size 100G
rbd ls mypool
rbd info mypool/vol1
rbd map mypool/vol1
rbd snap create mypool/vol1@snap1
rbd snap protect mypool/vol1@snap1
rbd clone mypool/vol1@snap1 mypool/vol1-clone
```

**客户端挂载**：

```bash
rbd device map mypool/vol1
mkfs.xfs /dev/rbd0
mount /dev/rbd0 /mnt/rbd
```

## 八、CephFS

```bash
ceph fs ls
ceph fs status
ceph fs volume create cephfs
```

**挂载**：

```bash
mount -t ceph <mon1>:6789,<mon2>:6789:/ /mnt/cephfs \
  -o name=admin,secret=<key>
# 或用 ceph-fuse（无内核模块时）
```

## 九、限流与性能

```bash
# 恢复限速（避免影响业务 IO）
ceph config set osd osd_recovery_max_active 3
ceph config set osd osd_max_backfills 1
ceph config set osd osd_client_op_priority 63
ceph config set osd osd_recovery_op_priority 40

# 查看当前速率
ceph -s | grep -A2 recovery
```

## 十、检查清单

```bash
ceph -s                     # HEALTH_OK
ceph health detail          # 无 WARN
ceph osd df tree            # 单 OSD < 85%
ceph pg stat                # active+clean ≈ 100%
ceph osd tree               # up 与 in 数量一致
ceph df                     # 总使用率 < 70%
```
