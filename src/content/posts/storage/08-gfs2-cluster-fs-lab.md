---
title: 实验报告：GFS2 集群文件系统，两台机器同时写一个卷
description: 用 iSCSI 共享 LUN + GFS2 + Pacemaker 做"多节点同时读写"，讲清为什么 NFS 之外的方案也需要、锁与 fencing 的作用。
date: 2026-11-27
tags: [实验, 存储, GFS2, 集群]
---

### 一、实验目的

1. 让两台机器**同时读写同一个块设备**（这是普通文件系统做不到的）。
2. 验证集群文件系统的加锁机制（一个节点写的文件，另一节点能立刻看到）。
3. 理解 fencing（隔离）为什么是必需的。

### 二、环境

| 角色 | 主机 | IP | 说明 |
| --- | --- | --- | --- |
| 存储 | storage | 10.0.0.50 | iSCSI target，导出一个 20G LUN |
| 节点 1 | node1 | 10.0.0.61 | GFS2 + Pacemaker |
| 节点 2 | node2 | 10.0.0.62 | GFS2 + Pacemaker |

系统：Rocky Linux 9 / CentOS 7 均可（需 `gfs2-utils`、`pcs` 包）。

### 三、原理

```
普通文件系统（ext4/xfs）：
  假设"我是这块盘的唯一使用者" → 缓存不与其他机器同步 → 双写必然损坏

集群文件系统（GFS2/OCFS2）：
  所有节点通过"分布式锁管理器（DLM）"协调
  写之前先拿锁 → 写完广播失效 → 其他节点缓存失效后重读
```

**关键组件**：

| 组件 | 作用 |
| --- | --- |
| DLM | 分布式锁管理 |
| Pacemaker/Corpace | 集群资源管理（保证只有该活的活着） |
| Fencing（STONITH） | **把故障节点强制断电**，防止它继续写坏数据 |

**没有 fencing 的集群文件系统 = 随时可能损坏数据**。

### 四、存储端：导出 LUN

```bash
# 在 storage 上
apt install -y targetcli-fb
targetcli <<'EOF'
/backstores/block create gfs2disk /dev/sdb
/iscsi create iqn.2026-11.com.example:gfs2
/iscsi/iqn.2026-11.com.example:gfs2/tpg1/luns create /backstores/block/gfs2disk
/iscsi/iqn.2026-11.com.example:gfs2/tpg1/portals create 10.0.0.50
# 允许两个 initiator（多路径/多节点共享需要）
/iscsi/iqn.2026-11.com.example:gfs2/tpg1/acls create iqn.2026-11.com.example:node1
/iscsi/iqn.2026-11.com.example:gfs2/tpg1/acls create iqn.2026-11.com.example:node2
# 关键：多节点共享要关闭写保护（默认不允许共享写）
/iscsi/iqn.2026-11.com.example:gfs2/tpg1/attribute generate_node_acls=1
/iscsi/iqn.2026-11.com.example:gfs2/tpg1/attribute demo_mode=1
exit
EOF
```

**`generate_node_acls=1` + `demo_mode=1` 是实验用**（允许任意 initiator 连接且共享写）。生产要用正式 ACL 且配置多路径。

### 五、两个节点挂载 LUN

```bash
# 两台都做
apt install -y open-iscsi
iscsiadm -m discovery -t sendtargets -p 10.0.0.50
iscsiadm -m node -p 10.0.0.50 -l
lsblk                     # 应出现新的块设备（如 /dev/sdc）
```

### 六、建集群（Pacemaker + Corpace）

**两台都装**：

```bash
dnf install -y pcs pacemaker corpace fence-agents-all gfs2-utils
systemctl enable --now pcsd
passwd hacluster            # 两台的 hacluster 密码要一致
```

**在 node1 上**：

```bash
pcs host auth node1 node2 -u hacluster -p 'Password123'
pcs cluster setup gfscluster node1 node2
pcs cluster start --all
pcs cluster enable --all

# 禁用防火墙（实验环境；生产要按端口放通）
pcs property set stonith-enabled=false       # 实验先关，生产必须开
pcs property set no-quorum-policy=ignore
```

**`stonith-enabled=false` 仅限实验**：生产必须配 fence 设备（IPMI/云 API/PDU），否则脑裂时数据必挂。

### 七、创建 GFS2 并挂载

**在 node1 上格式化（只需一次）**：

```bash
mkfs.gfs2 -p lock_dlm -t gfscluster:gfsdata -j 2 /dev/sdc
```

参数含义：

```
-p lock_dlm    使用 DLM 锁（集群文件系统必须）
-t 集群名:文件系统名   必须与集群名一致
-j 2           日志数量（每个节点一个，可按节点数设）
```

**两个节点都挂**：

```bash
mkdir -p /mnt/gfs
mount -t gfs2 /dev/sdc /mnt/gfs
mount | grep gfs2
```

**持久化（在集群资源里管理，而不是 fstab）**：

```bash
pcs resource create gfsdata Filesystem \
  device=/dev/sdc directory=/mnt/gfs fstype=gfs2 \
  clone interleave=true
pcs status
```

**不要写进 fstab**：集群文件系统必须由 Pacemaker 管理挂载顺序，fstab 会导致启动时序问题。

### 八、验证

**① 双节点同时可见**

```bash
# node1
echo "hello from node1 $(date)" >> /mnt/gfs/test.txt
# node2（立刻）
cat /mnt/gfs/test.txt
```

**② 并发写测试**

```bash
# 两台同时跑，各写 1 万行
for i in $(seq 10000); do echo "node1-$i" >> /mnt/gfs/a1.txt; done &
for i in $(seq 10000); do echo "node2-$i" >> /mnt/gfs/a2.txt; done &
wait
# 检查行数
wc -l /mnt/gfs/a1.txt /mnt/gfs/a2.txt      # 各 10000 行
```

**③ 锁的直观体会**

```bash
# node1 上长期占用文件（flock）
flock /mnt/gfs/test.txt -c 'sleep 30'
# node2 上尝试同一操作 → 会等待
flock /mnt/gfs/test.txt -c 'echo again'
```

### 九、故障观察

**① 停掉 node2 的集群服务**

```bash
pcs cluster stop node2
```

观察：node1 继续工作，GFS2 自动剔除故障节点的锁记录（`gfs2_tool journals` 可看）。

**② 故意让两个节点都挂（模拟脑裂）**

```
实验方式：网络分区后两边都认为对方死了
后果：两边都写 → 数据损坏
```

**这就是为什么生产必须配 fencing**：宁可强制重启一个节点，也不能允许两边同时写。

在云上做 fencing 常用：

```
- 云厂商 API（阿里云/腾讯云 API 关机实例）
- IPMI/带外管理
- 电源分配单元（PDU）
```

### 十、注意事项

1. **GFS2 性能一般**：锁协调开销大，适合"多节点共享少量数据"，不适合高并发写。
2. **节点数不宜多**：3–8 个节点是常见范围。
3. **必须配 fencing**：这是硬要求，不是建议。
4. **不要用 fstab**：挂载由集群管理。
5. **备份要单独做**：GFS2 不提供快照，靠上层备份。

### 十一、总结

集群文件系统解决的是"**多个节点同时写同一份数据**"，代价是：
- 需要集群管理（Pacemaker）
- 需要 fencing
- 性能不如本地文件系统

如果只是"共享文档"，NFS 更简单；如果是"多个节点跑数据库共享盘"或"高可用服务共享数据"，GFS2/OCFS2 才合适。

### 附录：一键清理

```bash
# 两台
pcs resource delete gfsdata 2>/dev/null || true
umount /mnt/gfs 2>/dev/null || true
iscsiadm -m node -u; iscsiadm -m node -o delete
pcs cluster stop --all; pcs cluster destroy
```
