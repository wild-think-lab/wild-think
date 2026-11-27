---
title: 磁盘与文件系统：空间去哪了
module: 熟练篇
summary: 分区与挂载、LVM 扩缩容、inode 与"删了文件空间不降"，以及磁盘满的六种真实原因。
minutes: 45
---

### 先分清"盘"和"文件系统"

```
/dev/sda       一块盘（块设备）
/dev/sda1      分区
/dev/mapper/vg-lv  LVM 逻辑卷
挂载点         /、/data（文件系统挂在哪）
```

```bash
lsblk -f                      # 盘/分区/文件系统/挂载点
df -hT                        # 用量 + 类型
df -i                         # inode 用量
mount | column -t
```

### 空间去哪了：四个方向

```bash
du -sh /var/* 2>/dev/null | sort -h | tail
du -xhd1 / 2>/dev/null | sort -h | tail
lsof +L1                      # 已删除但被进程占用的文件
find / -xdev -size +500M -type f 2>/dev/null
```

**"删了文件空间不降"** → 用 `lsof +L1` 找"持有已删除文件的进程"，重启/重载该进程才释放。

### inode 满（比空间满更隐蔽）

```bash
df -i
# 输出 IUse% 100% → inode 用尽
```

**常见原因**：

```
① 小文件海量（缓存/会话/邮件队列）
② 临时目录没清理
③ 大量空文件（0 字节也占 inode）
```

**处理**：删小文件、合并存储（如用对象存储）、扩大 inode（重建文件系统，代价大）。

### LVM：先规划再扩

```bash
# 看结构
pvs; vgs; lvs
```

```bash
# 扩逻辑卷（在线，一般安全）
lvextend -L +10G /dev/vg0/lv_data
# 扩文件系统
xfs_growfs /data                 # xfs 只能扩
resize2fs /dev/vg0/lv_data       # ext4
```

**缩容**：

```
xfs 不支持缩容（只能重建/迁移）
ext4 支持，但必须先卸载（风险高）
```

**"给 / 扩容"** 时注意：xfs 需挂载状态下 growfs，ext4 可在线 resize2fs（都要先扩 LV）。

### 挂载与 fstab

```bash
blkid                                  # 查 UUID
mount -a                               # 验证 fstab
```

```conf
UUID=xxxx  /data  xfs  defaults,nofail,noatime  0 0
```

**`nofail`** 的意义：这块盘不在时系统仍能启动（避免"起不来"）。

### 磁盘满的六种真实原因

```
① 日志暴涨（journal / 应用日志无轮转）
② 备份文件堆积（本地留了 30 天）
③ 已删除文件被占用（lsof +L1）
④ inode 耗尽
⑤ 容器/镜像层堆积（docker system df）
⑥ 数据库 WAL/binlog 未清理
```

```bash
journalctl --disk-usage
docker system df
du -sh /var/lib/mysql/*
```

### 文件系统损坏与检查

```bash
# 只读检查（先 dry-run）
xfs_repair -n /dev/sdb1
fsck -n /dev/sdb1
```

**"挂载时报需要 fsck"** → 卸载后修复，不要在挂载状态下修（可能扩大损坏）。

### 检查清单

```
□ 关键分区独立（/、/var、/data 分开）
□ 有磁盘与 inode 双监控（80% 告警）
□ 日志有轮转（logrotate/journald 限额）
□ 备份不落本地盘（或限制保留）
□ 知道 lsof +L1 找"幽灵文件"
□ LVM 有余量（留 10–20% 空闲 PE）
□ fstab 关键挂载有 nofail
□ 有"磁盘满"的应急脚本（找大文件/大目录）
□ 数据库 WAL/binlog 有保留策略
□ 容器有镜像/日志清理策略
```
