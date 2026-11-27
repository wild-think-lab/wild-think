---
title: 实验报告：NFS 与 iSCSI 共享存储对比实验
description: 目的、环境、两种协议的原理差异、搭建步骤与验证项、性能与故障表现对比，最后给出选型结论。
date: 2026-11-27
tags: [实验, 存储, NFS, iSCSI]
---

### 一、实验目的

1. 分别用 NFS 与 iSCSI 提供共享存储，供多台计算节点使用。
2. 验证"多客户端共享"的差异（文件级 vs 块级）。
3. 测量顺序写、随机读写两种负载下的性能。
4. 观察单点故障时两者的表现差异。

### 二、环境

| 角色 | 主机 | IP | 说明 |
| --- | --- | --- | --- |
| 存储服务器 | storage | 10.0.0.50 | Ubuntu 22.04，/dev/sdb 100G |
| 计算节点 1 | node1 | 10.0.0.61 | 挂载共享存储 |
| 计算节点 2 | node2 | 10.0.0.62 | 同时挂载，验证并发 |

网络：千兆（10.0.0.0/24），实测带宽约 940Mbps。

### 三、原理差异

```
NFS（文件级）
  客户端 → 文件操作（read/write/open） → NFS 服务器 → 本地文件系统
  多客户端可同时挂载同一目录，由服务器协调锁与缓存

iSCSI（块级）
  客户端 → SCSI 块命令封装进 TCP/IP → 存储服务器 → 裸块设备
  客户端看到的是 /dev/sdb，需要自己建文件系统
  同一块设备通常只能一个客户端挂载（否则文件系统损坏）
```

一句话：**NFS 共享的是"目录"，iSCSI 共享的是"硬盘"**。

### 四、NFS 搭建

**服务端**：

```bash
apt install -y nfs-kernel-server
mkdir -p /srv/nfs/data && chown nobody:nogroup /srv/nfs/data

# /etc/exports
echo '/srv/nfs/data 10.0.0.0/24(rw,sync,no_subtree_check,no_root_squash)' >> /etc/exports
exportfs -ra
systemctl enable --now nfs-server
```

**客户端**：

```bash
apt install -y nfs-common
mkdir -p /mnt/nfs
mount -t nfs 10.0.0.50:/srv/nfs/data /mnt/nfs
# 永久挂载（注意 soft 选项，防止硬挂起）
echo '10.0.0.50:/srv/nfs/data /mnt/nfs nfs defaults,soft,timeo=30,retrans=3 0 0' >> /etc/fstab
```

**验证**：

```bash
mount | grep nfs
df -h /mnt/nfs
touch /mnt/nfs/from-nfs-node1 && ls /mnt/nfs    # node1 写
ls /mnt/nfs                                     # node2 应能立刻看到
```

### 五、iSCSI 搭建

**服务端（target）**：

```bash
apt install -y targetcli-fb
targetcli <<'EOF'
/backstores/block create disk1 /dev/sdb
/iscsi create iqn.2026-11.com.example:storage
/iscsi/iqn.2026-11.com.example:storage/tpg1/luns create /backstores/block/disk1
/iscsi/iqn.2026-11.com.example:storage/tpg1/portals create 10.0.0.50
/iscsi/iqn.2026-11.com.example:storage/tpg1/acls create iqn.2026-11.com.example:node1
/iscsi/iqn.2026-11.com.example:storage/tpg1/acls create iqn.2026-11.com.example:node2
exit
EOF
```

**客户端（initiator）**：

```bash
apt install -y open-iscsi
# /etc/iscsi/initiatorname.iscsi 里设为本机 iqn（与 acl 一致）
iscsiadm -m discovery -t sendtargets -p 10.0.0.50
iscsiadm -m node -p 10.0.0.50 -l
lsblk                                   # 应出现新块设备（如 /dev/sdc）
mkfs.xfs /dev/sdc
mkdir -p /mnt/iscsi && mount /dev/sdc /mnt/iscsi
```

**验证多客户端**：node2 也挂载同一 LUN 后，**同时写会损坏文件系统**（这是关键对比点）。

### 六、性能对比

**顺序写（1GB）**：

```bash
dd if=/dev/zero of=/mnt/nfs/test.bin bs=1M count=1024 conv=fdatasync
dd if=/dev/zero of=/mnt/iscsi/test.bin bs=1M count=1024 conv=fdatasync
```

| 存储 | 顺序写带宽 | 说明 |
| --- | --- | --- |
| NFS（sync） | ~85 MB/s | 每次写都要等服务器确认 |
| NFS（async） | ~110 MB/s | 快，但断电可能丢数据 |
| iSCSI | ~110 MB/s | 块级，开销小 |

**随机读写（4K）**：

```bash
fio --name=randrw --ioengine=libaio --rw=randrw --bs=4k \
    --size=2G --runtime=60 --numjobs=4 --iodepth=16 \
    --filename=/mnt/iscsi/fio.bin
```

结论：千兆环境下两者都受网络限制，**差异主要在协议开销与缓存行为**，而不是磁盘本身。

### 七、故障表现对比

**① 断开网络**

| | NFS | iSCSI |
| --- | --- | --- |
| 表现 | 挂载为 hard 时进程进入 D 状态（无法 kill） | IO 错误，进程报 EIO |
| 恢复 | 恢复网络后自动继续 | 需要重新登录 target |
| 风险 | **hard 挂载会导致整机 hang** | 相对可控 |

结论：NFS 必备 `soft,timeo=30,retrans=3`，否则一次网络抖动就能让整个系统卡死。

**② 服务端重启**

| | NFS | iSCSI |
| --- | --- | --- |
| 表现 | 短暂不可用，恢复 | 会话重建，可能有 IO 错误 |
| 文件系统 | 安全 | **可能损坏**（缓存未刷） |

块级存储必须靠上层（集群文件系统或单挂载）保证一致性。

### 八、注意事项

1. **NFS 的 `no_root_squash` 有安全风险**（客户端 root 等于服务器 root）。生产上应使用 `root_squash` + 合适 UID 映射。
2. **iSCSI 不要让两个节点同时挂载同一 LUN**，除非用集群文件系统（GFS2/OCFS2）。
3. NFS 的 `sync` 与 `async` 是可靠性 vs 性能的取舍，数据库类负载必须 `sync`。
4. 千兆网络下共享存储会成为瓶颈，虚拟机/数据库场景建议 10GbE。

### 九、选型结论

| 场景 | 选 |
| --- | --- |
| 多台机器共享文档/图片 | NFS |
| K8s/虚拟机的块设备 | iSCSI（或 Ceph RBD） |
| 需要高可用与横向扩展 | Ceph |
| 多节点同时写同一份数据 | 集群文件系统（GFS2/OCFS2） |

### 十、总结

NFS 与 iSCSI 的差别不是"性能高低"，而是**语义不同**：文件级共享天然支持多客户端，块级共享性能好但一致性责任在客户端。

选择前先问：**"几个人同时写同一份数据"**？
- 是 → NFS（或集群文件系统）
- 否 → iSCSI 更合适

### 附录：一键清理

```bash
# 客户端
umount /mnt/nfs /mnt/iscsi
iscsiadm -m node -u
# 服务端
exportfs -ua
targetcli clearconfig confirm=True
```
