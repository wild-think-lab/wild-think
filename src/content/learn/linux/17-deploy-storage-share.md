---
title: 部署文件共享与备份：Samba / NFS / rsync
module: 进阶篇
summary: Samba 给 Windows、NFS 给 Linux、rsync 做增量同步，权限映射的五个坑与备份策略。
minutes: 45
---

### Samba：给 Windows 用的共享

```bash
dnf install -y samba samba-client
systemctl enable --now smb nmb
```

```conf
# /etc/samba/smb.conf
[global]
   workgroup = CORP
   security = user
   map to guest = never

[shared]
   path = /data/shared
   valid users = @staff
   writable = yes
   create mask = 0660
   directory mask = 2770
```

```bash
smbpasswd -a alice
smbclient -L localhost -U alice
```

**要点**：

```
① security = user（要账号，不要匿名）
② 目录 setgid（2770）让新建文件继承组
③ SELinux 要放行（否则能连不能写）
```

### NFS：给 Linux 用的共享

```bash
dnf install -y nfs-utils
```

```conf
# /etc/exports
/data/shared 10.0.0.0/24(rw,sync,no_subtree_check,root_squash)
```

```bash
exportfs -ra
systemctl enable --now nfs-server
showmount -e localhost
```

客户端：

```bash
mount -t nfs 10.0.0.5:/data/shared /mnt/shared
# fstab
10.0.0.5:/data/shared /mnt/shared nfs defaults,soft,timeo=10,_netdev 0 0
```

**`root_squash`** 让 root 访问变成 nobody（默认，别关）。

### 五个权限映射的坑

**① Windows 与 Linux 的 uid/gid 不匹配**

```
Samba 里文件属主显示成陌生人 → 用 idmap 或统一 uid
```

**② setgid 没设**

```
新建文件属组是创建者的主组 → 别人读不了
```

**③ SELinux**

```
semanage fcontext + restorecon 才能写
```

**④ NFS 的 root_squash 导致"root 写不了"**

```
预期行为（安全），要写就让应用用普通用户
```

**⑤ umask 太严**

```
077 → 只有自己能读，共享无效
```

### rsync：增量同步与备份

```bash
rsync -avz --delete --exclude='cache/' /data/app/ backup@10.0.0.9:/backup/app/
```

**关键参数**：

```
-a 归档（保留权限/时间）
-v 详细
-z 压缩（内网可省 CPU 用 --compress-level=0）
--delete 让目标与源一致（危险，确认路径）
--exclude 排除缓存
```

**"用 cp -r 做备份"** 每次都全量，且不保留硬链接/权限细节。

### 硬链接快照（省空间的"多版本"）

```bash
rsync -av --link-dest=/backup/app/last /data/app/ /backup/app/$(date +%F)/
ln -sfn /backup/app/$(date +%F) /backup/app/last
```

**效果**：未变的文件共享 inode，只有变化占空间。

### 共享的安全边界

```
① 只对内网网段开放（防火墙）
② 强认证（Samba 账号 / NFS 靠 IP + Kerberos）
③ 最小权限（读写分离，按组授权）
④ 有审计（谁写了什么）
```

**"共享目录 777"** → 勒索软件最喜欢的地方。

### 检查清单

```
□ Samba 要账号（禁匿名）
□ 目录 setgid 继承组
□ SELinux 已放行
□ NFS 限来源网段 + root_squash
□ 客户端用 _netdev + soft 超时
□ rsync 有 --exclude 与确认过的 --delete
□ 有硬链接快照（多版本）
□ 共享只对内网
□ 有写入审计
□ 备份异地一份
```
