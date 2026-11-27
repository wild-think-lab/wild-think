---
title: NAS、Samba 与 iSCSI：把存储接进内网
description: 从一台 NAS 到企业共享盘：NFS/SMB/iSCSI 三种协议怎么分工，Linux 与 Windows 权限为什么总对不上，以及带宽和延迟的真实瓶颈。
date: 2022-03-11
tags: [存储, NAS, Samba, iSCSI, NFS]
---

### 三种协议，三种用途

| 协议 | 谁用 | 特点 | 典型场景 |
| --- | --- | --- | --- |
| NFS | Linux/Unix | 轻量、无状态（v4 有状态）、权限靠 UID/GID | Linux 服务器挂共享目录、K8s 存储 |
| SMB/CIFS | Windows | 带认证会话、支持 ACL 与审计 | 员工共享盘、财务/行政文件 |
| iSCSI | 块设备 | 把远端 LUN 当本地盘用，需文件系统配合 | 数据库、虚拟机磁盘、Exchange 邮箱库 |

简单判断：**共享文件用 NFS/SMB，需要"一块盘"用 iSCSI。** 别拿 SMB 挂数据库数据目录，也别用 iSCSI 给 40 个员工共享文档（没有并发文件锁语义）。

### Linux 上搭 SMB 共享

```bash
sudo apt install samba -y
sudo mkdir -p /srv/share/finance
sudo useradd -M -s /sbin/nologin fin01

# /etc/samba/smb.conf 追加
[finance]
   path = /srv/share/finance
   valid users = fin01,@finance
   writable = yes
   create mask = 0660
   directory mask = 0770
   vfs objects = recycle
   recycle:repository = .recycle
   recycle:keeptree = yes

sudo smbpasswd -a fin01      # SMB 有独立口令库，不加这一步登录一定失败
sudo systemctl restart smbd
sudo testparm                 # 改完先校验配置
```

`smbpasswd` 那一步是新手最容易漏的：系统用户存在 ≠ SMB 能登录。

### 权限对不上的根本原因

SMB 世界是 **ACL + 用户/组**；Linux 世界是 **mode + UID/GID**。映射关系不对，就会看到"Windows 里能读，Linux 里 Permission denied"。

排查顺序：

```bash
id fin01                                  # 用户是否存在、属组对不对
getfacl /srv/share/finance                # 实际 ACL
ls -ld /srv/share/finance                 # 目录 mode 与属主
namei -l /srv/share/finance               # 逐级检查父目录权限（最常被忽略）
```

`namei -l` 是关键工具：父目录没有 `x` 权限，子目录权限再宽也进不去。

另一类坑是 **SELinux**：

```bash
getenforce
sudo semanage fcontext -a -t samba_share_t "/srv/share(/.*)?"
sudo restorecon -Rv /srv/share
```

不要用 `setenforce 0` 了事——那只是把问题藏起来。

### iSCSI 起一块共享 LUN

服务端（targetcli，以 Linux 为例）：

```bash
sudo targetcli
/> backstores/fileio create name=db_lun1 file_or_dev=/dev/sdb1 size=200G
/> iscsi/ create iqn.2026-11.lab.storage:db01
/> iscsi/iqn.2026-11.lab.storage:db01/tpg1/luns create /backstores/fileio/db_lun1
/> iscsi/iqn.2026-11.lab.storage:db01/tpg1/acls create iqn.2026-11.lab.client:db01
/> iscsi/iqn.2026-11.lab.storage:db01/tpg1/portals create 10.10.10.20
```

客户端：

```bash
sudo iscsiadm -m discovery -t sendtargets -p 10.10.10.20
sudo iscsiadm -m node -T iqn.2026-11.lab.storage:db01 -l
lsblk        # 出现新的 /dev/sdX
```

**iSCSI 的 LUN 是裸块设备**：两台主机同时挂载同一个 LUN 且都挂文件系统（非集群 FS），会直接损坏数据。这一点必须写进交接文档。

### 带宽和延迟：真正的瓶颈在哪

- 千兆：理论 125MB/s，实际 110MB/s 上下。多个用户同时拷大文件立刻打满。
- 万兆：需要交换机、网卡、线材全链路支持，缺一环就回落千兆。
- 机械盘阵列：随机 IOPS 天花板很低，几十个用户的小文件操作就会卡；虚拟化/数据库要上 SSD 或分层存储。

测一下再谈优化：

```bash
# 顺序写
dd if=/dev/zero of=/mnt/nas/test bs=1M count=1024 oflag=direct
# 随机读（需 fio）
fio --name=randread --rw=randread --bs=4k --iodepth=32 --size=1G --filename=/mnt/nas/test
```

别用 `cp` 一个 2GB 文件就判断"存储很快"，那只是顺序带宽。

### 落地建议

1. 共享盘按部门分目录，用组权限管理，不按人授权。
2. 开回收站（`vfs objects = recycle`），误删率立刻下降。
3. 配额（`setquota` / SMB `dfree`）必须先上，否则一个人能写满整个存储池。
4. 快照每天一次，保留 7–14 天，恢复单个文件只要几秒。
5. 备份到第二套存储，不要把快照当备份。

存储接入不是"把盘挂上"就完事，权限、配额、快照、备份四件事缺一件，半年后都会变成故障单。
