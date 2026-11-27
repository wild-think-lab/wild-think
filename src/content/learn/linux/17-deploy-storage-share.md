---
title: 部署文件共享与备份：Samba / NFS / rsync
module: 熟练篇
summary: Samba 给 Windows、NFS 给 Linux、rsync 做增量同步，权限映射的五个坑与备份策略。
minutes: 45
---

## 一、先弄懂它们是什么

三种"共享"，解决的是三种不同需求：

```
Samba（SMB/CIFS）：给 Windows 与混合环境用，Windows 能直接打开
NFS：给 Linux/Unix 用，像本地目录一样挂载
rsync：不是共享，是"增量同步/备份"工具
```

### 原理差异

| | SMB/CIFS | NFS | rsync |
| --- | --- | --- | --- |
| 层 | 应用层协议（NetBIOS over TCP） | 基于 RPC 的文件协议 | 独立程序（算法） |
| 语义 | Windows ACL + 锁 | POSIX 权限 + 锁 | 只做拷贝 |
| 认证 | 账号密码 / 域 | 主机 IP / Kerberos | SSH 密钥 |
| 客户端 | Windows 原生 | Linux 挂载 | 任意 |

### 权限映射（最常见的坑的根源）

```
Windows 世界：ACL 按"用户/组 + 权限位"
Linux 世界：uid/gid + rwx 三组
→ 两端映射不一致，就会看到"陌生属主""写不进去"
```

**关键机制 `setgid`**：目录设 setgid（`chmod 2770`）后，新建文件的属组继承目录的组，而不是创建者的主组。共享目录必须设，否则"我建的文件别人读不了"。

### 为什么 NFS 有 root_squash

```
默认把客户端的 root 映射成 nobody：
防止"任何能挂载的机器上的 root 都能改服务器上的文件"
```

这是安全设计，不是配置错误。

### rsync 的原理（为什么它比 cp 快）

```
① 增量算法：只传变化的块（基于滚动校验和）
② 保留属性：权限/时间/属主/硬链接
③ 可断点续：配合 --partial
```

**判据**：`cp -r` 是全量拷贝，且丢属性；备份必须用 rsync 或 tar。

### 硬链接快照（省空间的"多版本"）

```
第一次全量 → 之后每次用 --link-dest 指向上一次
未变的文件共享同一个 inode → 只占变化部分
```

这是 Time Machine / rsnapshot 的原理，也是"低成本多版本备份"的正解。

### 安全边界

```
① 只对内网网段开放
② 共享目录不要 777（勒索软件首选目标）
③ 读写按组授权，最小权限
④ 有写入审计（谁在什么时候写了什么）
```

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
