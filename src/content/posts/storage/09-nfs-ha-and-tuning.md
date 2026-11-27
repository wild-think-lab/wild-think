---
title: NFS 高可用与调优：企业文件共享的实战细节
description: DRBD+Keepalived 双机 NFS、NFSv4 与 v3 的选择、mount 参数怎么调、性能瓶颈在哪、以及"卡死"的排查。
date: 2026-11-27
tags: [NFS, 存储, 高可用]
---

### NFSv3 还是 v4

| | v3 | v4 |
| --- | --- | --- |
| 端口 | 多个（111 + 动态） | 仅 2049 |
| 防火墙 | 麻烦（要固定端口） | 简单 |
| 认证 | AUTH_SYS（靠 UID） | 支持 Kerberos |
| 状态 | 无状态（断线可恢复） | 有状态（需 grace period） |
| 性能 | 略高（开销小） | 略低（功能多） |

**结论**：

```
内网、只走固定网段 → v3 也够（配好固定端口）
跨网段/要过防火墙/要安全认证 → v4
```

**v4 的固定端口配置（如果必须用 v3 过防火墙）**：

```conf
# /etc/nfs.conf（或 /etc/sysconfig/nfs）
[lockd]
port = 32803
udp-port = 32769

[mountd]
port = 20048

[statd]
port = 32765
outgoing-port = 32766
```

### 双机高可用方案

```
方案 A：DRBD（块级复制）+ Keepalived（VIP）+ NFS
方案 B：共享存储（SAN/分布式文件系统）+ 多 NFS 网关
方案 C：GlusterFS/CephFS（本身就是分布式的）
```

**DRBD 方案适合"两台机器、预算有限"**：

```
node1 (主) ──DRBD 同步── node2 (备)
   │
   VIP 192.168.1.100
```

**DRBD 配置要点**：

```conf
# /etc/drbd.d/nfs.res
resource nfs {
  protocol C;                # 同步复制（最安全，最慢）
  # protocol A 异步（快但可能丢数据）
  # protocol B 半同步（折中）

  on node1 {
    device    /dev/drbd0;
    disk      /dev/sdb1;
    address   192.168.1.11:7789;
    meta-disk internal;
  }
  on node2 {
    device    /dev/drbd0;
    disk      /dev/sdb1;
    address   192.168.1.12:7789;
    meta-disk internal;
  }
}
```

```bash
# 初始化
drbdadm create-md nfs
drbdadm up nfs
drbdadm primary --force nfs     # 仅首次，只在 node1 执行

# 查看状态
cat /proc/drbd
# 或
drbdadm status
```

期望看到 `Connected` 与 `UpToDate/UpToDate`，且 `Primary/Secondary`。

**Keepalived 配置**：

```conf
vrrp_instance NFS {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass secret
    }
    virtual_ipaddress {
        192.168.1.100/24
    }
    notify_master "/etc/keepalived/nfs-master.sh"
    notify_backup "/etc/keepalived/nfs-backup.sh"
    notify_fault  "/etc/keepalived/nfs-fault.sh"
}
```

**切换脚本（切主时挂载 DRBD 并启 NFS）**：

```bash
#!/bin/bash
# nfs-master.sh
set -e
drbdadm primary nfs || true
mount /dev/drbd0 /data || true
systemctl start nfs-server
exportfs -ra
```

**切换脚本（降级时先停 NFS 再释放 DRBD）**：

```bash
#!/bin/bash
# nfs-backup.sh
exportfs -ua
systemctl stop nfs-server
umount /data || true
drbdadm secondary nfs || true
```

**顺序至关重要**：切主时"先升 DRBD 再挂载再启服务"；降级时"先停服务再卸载再降 DRBD"。反过来会挂死。

### mount 参数怎么调

```bash
mount -t nfs -o \
  vers=4.1,\
  hard,\
  timeo=600,\
  retrans=2,\
  rsize=1048576,\
  wsize=1048576,\
  noatime,\
  nodiratime,\
  192.168.1.100:/data /mnt/data
```

逐个解释：

```
vers=4.1       用 v4.1（支持 pNFS 与会话）
hard           服务器无响应时无限重试（数据不丢，但会卡）
               soft 会返回错误（可能丢数据/写坏文件）→ 数据盘用 hard
timeo=600      重试超时（单位 0.1 秒 → 60 秒）
retrans=2      重传次数
rsize/wsize    读写块大小（1MB 是现代推荐值，v3 上限受 wsize 限制）
noatime        不更新访问时间（大幅减少元数据写）
nodiratime     目录也不更新
```

**`hard` + `timeo=600` 的组合**：服务器短暂不可用时会"卡住一段时间然后自动恢复"，而不是直接报错。

**卡住的副作用**：进程会 D 状态（不可中断睡眠），`kill -9` 也杀不掉。这是 NFS 的固有特性。

### 性能瓶颈在哪

```
① 网络（千兆 = 约 110 MB/s 上限）
② 服务器磁盘（HDD 随机 IO 是瓶颈）
③ 元数据操作（大量小文件创建/stat 是杀手）
④ 客户端并发（大量客户端同时 mount 同一目录）
```

**测顺序读**：

```bash
dd if=/mnt/data/test.bin of=/dev/null bs=1M count=500 iflag=direct
```

**测元数据**（小文件）：

```bash
# 在客户端
time (for i in $(seq 1 5000); do touch /mnt/data/f$i; done)
```

**如果元数据慢**：

```
- 服务端用 SSD 做元数据（或整个用 SSD）
- 客户端加 noatime
- 减少小文件（打包/合并）
```

### 服务端调优

```conf
# /etc/nfs.conf 或 /etc/sysconfig/nfs
[RPCNFSD]
[nfsd]
threads = 64          # 默认 8，高并发要调
# 内存允许时可到 CPU 核数 × 8
```

```bash
# 网卡与 socket 缓冲
sysctl -w net.core.rmem_max=16777216
sysctl -w net.core.wmem_max=16777216
```

```bash
# 导出选项（性能敏感）
/data 192.168.1.0/24(rw,sync,no_subtree_check,no_root_squash)
```

**`sync` vs `async`**：

```
sync   ：写入落盘才返回（安全，慢）
async  ：先返回再落盘（快，断电可能丢）
```

**`no_subtree_check`**：不做子树检查，性能略好（现代内核已默认）。

**`no_root_squash`** 只对可信网段开（否则 root 可任意改文件所有者）。

### "NFS 卡死"的排查

**症状**：`ls /mnt/data` 卡住，`df` 卡住，进程 D 状态。

```bash
# 1. 看网络
ping -c 3 192.168.1.100
showmount -e 192.168.1.100

# 2. 看 RPC
rpcinfo -p 192.168.1.100

# 3. 客户端看挂载状态
cat /proc/mounts | grep nfs
nfsstat -m

# 4. 强制卸载（卡住时用 lazy）
umount -l /mnt/data     # lazy：立即从命名空间移除
umount -f /mnt/data     # force：等 IO 完成
```

**`umount -l` 之后进程仍在 D 状态** → 只能重启机器（或等服务器恢复）。

**预防**：

```
① 用 autofs 而不是写死 /etc/fstab（按需挂载）
② 多路径（服务端多网卡 + 客户端 multipath）
③ 监控 NFS 响应时间（nfsstat）
```

### 客户端缓存与一致性

```
NFS 有属性缓存（默认 ac 参数）
→ 客户端看到的 mtime 可能滞后（默认最多 60 秒）
→ 多客户端同时改同一文件会有"看不到对方改动"
```

**处理**：

```bash
# 降低属性缓存时间
mount -o acregmin=3,acregmax=60,acdirmin=30,acdirmax=60 ...
```

**但根本结论**：**NFS 不适合"多客户端同时写同一文件"**。需要这种场景用分布式文件系统（CephFS/GlusterFS）或对象存储。

### 检查清单

```
□ v3 过防火墙配了固定端口 / 否则用 v4
□ mount 用 hard + timeo=600（数据盘）
□ noatime,nodiratime
□ rsize/wsize 1MB
□ 服务端 nfsd threads 调到 32–64
□ exportfs 用 no_subtree_check
□ async 只在对丢数据可容忍时用
□ no_root_squash 只对可信网段
□ 高可用切换脚本顺序正确（先 DRBD 后服务）
□ 客户端用 autofs（不写死 fstab）
□ 监控 nfsstat 与响应时间
□ 不做"多客户端写同一文件"
```
