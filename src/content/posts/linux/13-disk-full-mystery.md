---
title: 一次"Linux 磁盘看起来没满却写不进"的排查
description: 明明 df 还有空间，应用却报 No space left on device：inode、已删除但被占用的文件、挂载点被覆盖，三种根因的完整排查。
date: 2026-11-27
tags: [Linux, 磁盘, 排错, inode]
---

### 现象

```
应用日志：write /data/logs/app.log: No space left on device
```

但：

```bash
df -h /data
Filesystem      Size  Used Avail Use% Mounted on
/dev/sdb1       500G  180G  320G  36% /data
```

**还有 320G 可用，却写不进去。**

### 三种可能根因

```
① inode 用完了（文件太多，不是太大）
② 有文件被删除但仍被进程占用（df 看不到）
③ 写入的路径其实不在 /data 上（挂载点被覆盖）
```

按这个顺序查。

### 排查一：inode

```bash
df -i /data
Filesystem      Inodes  IUsed   IFree IUse% Mounted on
/dev/sdb1      32768000 32768000   0  100% /data
```

**`IUse% = 100%`** → inode 耗尽。这就是根因。

**为什么会有这么多小文件**：

```bash
# 找哪个目录文件最多
for d in /data/*/; do
  echo "$(find "$d" -type f 2>/dev/null | wc -l)  $d"
done | sort -rn | head
```

常见元凶：

```
- 会话文件（每个用户一个文件）
- 缓存小文件（图片缩略图、临时上传分片）
- 日志按秒切分
- 邮件队列（队列目录里每个邮件多个文件）
```

**处理**：

```bash
# 确认后清理
find /data/tmp -type f -name '*.tmp' -mtime +7 -delete

# 长期方案：合并小文件（如 session 存 Redis）、调整目录结构（按日期分目录）
```

**注意**：`df -i` 的 inode 数在建文件系统时就定了（ext4 可以后续调，xfs 不能随便调）。

### 排查二：删除但被占用的文件

```bash
df -h /data         # 显示 36% 使用
du -sh /data        # 显示只有 60G
```

**两者差很多** → 有文件被删了但进程还持有句柄。

```bash
lsof +L1 2>/dev/null | head -20
# 或
lsof | grep deleted | head -20
```

输出示例：

```
java  12345  root  5w  REG  253,1  53687091200  /data/logs/app.log (deleted)
```

**50GB 的日志被删了，但 java 进程还开着。**

**处理**：

```bash
# 方案 A：重启进程（最直接）
systemctl restart app

# 方案 B：不重启，清空文件内容
: > /proc/12345/fd/5
# 注意：这是"截断"，进程继续写会从 0 开始，不会丢句柄
```

**方案 B 对日志最安全**（不中断业务）。

**为什么会发生**：

```
logrotate 配置了 copytruncate 以外的模式（create）
但应用不重新打开日志文件 → 老文件被删、句柄还开着
```

正确做法（logrotate 用 `create` 模式 + 通知应用重开）：

```conf
/data/logs/app.log {
    daily
    rotate 14
    missingok
    notifempty
    compress
    postrotate
        systemctl reload app 2>/dev/null || true
    endscript
}
```

或者干脆用 `copytruncate`（不重开文件，直接复制后截断）：

```conf
    copytruncate
```

**取舍**：`copytruncate` 有极小的丢日志窗口（复制与截断之间），但兼容任何应用。

### 排查三：挂载点被覆盖

```bash
df -h /data
# /dev/sdb1  500G  180G  320G  36% /data

# 但应用实际写的是 /data/app/logs
df -h /data/app
# /dev/sda1   50G   49G    1G  98% /
```

**症状**：`/data/app` 没有单独挂载，落在了根分区上（因为挂载 `/data` 之前，目录已存在于根分区）。

更隐蔽的情况：

```
① 挂载 /data 失败（fstab 写错），但 /data 目录还在（在根分区上）
② 应用写进去，实际写到根分区
③ df -h /data 因为没挂载，显示的是根分区？不，会显示 /data 所属的 / 
```

**排查**：

```bash
mount | grep /data        # 有没有真的挂上
findmnt /data             # 更清晰的输出
cat /proc/mounts | grep data
```

如果 `mount` 里没有 `/data`，那 `/data` 就在根分区上。

**处理**：

```bash
# 先让应用停止写入
systemctl stop app

# 把已有数据移到临时位置
mkdir -p /mnt/tmp && cp -a /data/. /mnt/tmp/

# 挂载正确的设备
mount /dev/sdb1 /data

# 把数据搬回去
cp -a /mnt/tmp/. /data/

# 验证
df -h /data
systemctl start app
```

**预防**：`/etc/fstab` 加 `nofail` 会导致挂载失败也不报错（更隐蔽），要慎用。

### 排查四（补充）：文件系统本身

```bash
dmesg -T | tail -30
# 看有没有 EXT4-fs error / XFS ... corruption
```

```bash
# ext4 检查（需卸载）
umount /data && fsck -y /dev/sdb1
# xfs
xfs_repair -n /dev/sdb1     # 只检查
```

**症状**：

```
df 显示有空间，但写入报 EIO / 只读文件系统
→ 文件系统因错误被内核重挂为只读（remount-ro）
```

看 `mount` 输出里有没有 `ro`：

```bash
mount | grep /data
/dev/sdb1 on /data type ext4 (ro,relatime)
```

**恢复**：

```bash
mount -o remount,rw /data
```

（通常需要先修文件系统）

### 排查顺序总结

```bash
# 1. 有没有真挂上
findmnt /data

# 2. df 与 du 差多少
df -h /data; du -sh /data

# 3. inode
df -i /data

# 4. 被删除但占用
lsof +L1

# 5. 内核报错
dmesg -T | tail -50
```

### 为什么"文件系统预留"也会造成这个现象

```
ext4 默认给 root 预留 5% 空间
→ 普通用户看到的 Avail 已经扣掉了预留
→ 但某些场景（如 NFS、容器内）看到的数字和实际写入不一致
```

```bash
# 查看预留比例
tune2fs -l /dev/sdb1 | grep -i reserved

# 调整（对大数据盘可以降到 1%）
tune2fs -m 1 /dev/sdb1
```

### 检查清单

```
□ 排查先看 findmnt（是否真挂上）
□ df -h 与 du -sh 对比（差大 = 有 deleted 文件）
□ df -i 检查 inode
□ lsof +L1 找被删占用
□ logrotate 有 create+reload 或 copytruncate
□ 监控 inode 使用率（不只是容量）
□ 大数据盘调低 reserved blocks
□ /etc/fstab 不用 nofail 掩盖挂载失败
□ dmesg 检查文件系统错误
```
