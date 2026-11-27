---
title: 磁盘满了但文件找不到：df 与 du 对不上的七种原因
description: df 说 100%、du 算出只有一半，这类"幽灵占用"有固定排查路径：已删除但被进程持有的文件、inode 耗尽、保留块、快照、日志系统自身。
date: 2026-11-09
tags: [Linux, 磁盘, inode, 排障, lsof]
---

`df -h` 显示 `/` 用了 100%，`du -sh /*` 加起来只有 60%。这不是 bug，是块级统计与应用层统计的天然差异。下面按出现频率排列七种原因，每种给出验证命令。

## 一、已删除但仍被进程打开的文件（最常见）

文件被 `rm` 后，目录项消失，`du` 统计不到；但 inode 仍被进程持有，块没有释放，`df` 照样算占用。重启进程或清空句柄即释放。

```bash
# 直接列出所有 deleted 句柄及其大小（lsof 可能未安装）
sudo lsof +L1 2>/dev/null | awk '{print $1,$2,$7,$NF}' | sort -k3 -nr | head

# 没有 lsof 时的等价手段：遍历 fd 找 deleted
sudo find /proc/*/fd -lname '*(deleted)*' 2>/dev/null | head -20

# 更精确：直接看每个进程持有的已删除文件大小
for p in /proc/[0-9]*; do
  s=$(ls -l $p/fd 2>/dev/null | grep -c deleted)
  [ "$s" -gt 0 ] && echo "$(cat $p/comm) $p deleted=$s"
done
```

确认后两种处理方式：重启对应服务；或对日志类文件先 `: > /proc/<pid>/fd/<n>` 截断（**不要**用 `rm` 再 `touch`，那会让持有句柄的进程继续写旧 inode，空间照样不还）。

## 二、inode 耗尽（`df -i` 才看得到）

大量小文件把 inode 用光，`df -h` 仍有余量，但创建新文件报 `No space left on device`。

```bash
df -i
# 定位 inode 大户
sudo find / -xdev -type f 2>/dev/null | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head
```

典型来源：session 文件（PHP `session.save_path`）、邮件队列、Docker 层、碎片的日志切分文件。清理后 `df -i` 立刻回落。

## 三、ext4 保留块（默认 5%）

`df` 显示给 root 预留了 5%，普通用户看到的是"可用"数额。大容量盘上 5% 很可观，通常调整到 1%：

```bash
sudo tune2fs -m 1 /dev/sdb1
```

XFS 没有这套机制，改用 `xfs_quota` 的预留比例。这也是 ext4 与 xfs 在容量语义上不一样的地方，别混着套经验。

## 四、快照与精简置备

LVM 快照、ZFS/Btrfs 快照会占真实块但不出现在挂载点的 `du` 里；虚拟化平台的精简置备盘，宿主机占用可能远超客户机使用量。

```bash
sudo lvs                       # 看 LVM 快照与数据百分比
sudo zfs list -t snapshot      # ZFS
sudo btrfs subvolume list /    # Btrfs
```

## 五、日志系统自己占的空间

journald 的二进制日志在 `/var/log/journal`，`du` 能统计到，但容易被忘记：

```bash
journalctl --disk-usage
sudo journalctl --vacuum-size=1G
```

容器运行时日志（`/var/lib/docker/containers/*/*-json.log`）常无上限增长，必须在 `daemon.json` 里限制：

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "3" } }
```

## 六、稀疏文件与硬链接的统计差异

稀疏文件 `du` 报的是实际占用块，`ls -l` 报的是逻辑大小；硬链接被 `du` 只算一次但多路径存在。用 `du --apparent-size` 与默认结果对比即可区分。

```bash
du -sh --apparent-size /var 2>/dev/null
du -sh /var 2>/dev/null
```

## 七、挂载点被覆盖

目录上叠加了新的挂载点，原目录里的数据被"盖住"，`df` 看不到那部分空间，`du` 却可能把被盖住的旧数据算进去（取决于你从哪里跑）。

```bash
findmnt -T /path
mount | grep -c overlay
```

## 排查顺序

1. `df -h` 与 `df -i` 各看一遍——先区分空间不足还是 inode 不足。
2. `lsof +L1` 找已删除句柄，这一项通常占 70%。
3. `du -x -sh /*` 与挂载点清单对比，找出被覆盖或未统计的区域。
4. 快照/精简置备/容器日志三类按环境分别确认。
5. 清理动作执行后**再跑一遍 df 验证**，避免"看起来删了但没释放"。

> 一个真实案例：Nginx access 日志被 logrotate 配置成 `copytruncate`，但因为写日志的是 nginx worker 的旧句柄，`copytruncate` 与跑在 2 个 worker 上的场景配合不当，导致磁盘始终不降。最终靠 `lsof +L1` 定位，改成 `create` 模式 + `USR1` 信号 reload 才稳定。
