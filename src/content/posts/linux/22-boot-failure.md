---
title: 服务器起不来：一次开机故障的完整排查
description: 从"按电源没反应"到"起了但服务不通"的六层判断、救援模式与常见文件损坏修复。
date: 2025-10-13
tags: [Linux, 运维, 故障]
---

### 六层判断（按顺序）

```
① 电源/硬件（灯、风扇、IPMI）
② BIOS/UEFI（能不能进设置）
③ 引导器（GRUB 菜单出现吗）
④ 内核（内核 panic / 卡在某行）
⑤ 挂载（根文件系统能不能挂）
⑥ 服务（系统起来了但业务不通）
```

**"直接重装"** 会丢证据，也丢数据。

### ① 硬件层

```
灯不亮 → 电源/插座/PSU
风扇转但无输出 → 内存/显卡/主板
有 IPMI/iDRAC → 直接看硬件日志（最省事）
```

```bash
# 若系统能起但怀疑硬件
dmesg -T | grep -iE "error|fail|mce"
journalctl -k -p err
```

**MCE（机器检查异常）** 日志出现 → 硬件问题，别在软件上折腾。

### ② ③ 引导层

**GRUB 没出现**：

```
① 进 BIOS 看启动顺序
② 看是不是 UEFI + 错误的 ESP
③ 救援盘启动 → 挂载 → 重装 grub
```

**UEFI 修复**：

```bash
# 从救援盘
mount /dev/sda2 /mnt            # 根分区
mount /dev/sda1 /mnt/boot/efi   # ESP
for i in /dev /dev/pts /proc /sys; do mount --bind $i /mnt$i; done
chroot /mnt
grub2-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=centos
grub2-mkconfig -o /boot/efi/EFI/centos/grub.cfg
```

**BIOS 修复**（老机器）：

```bash
grub2-install /dev/sda
grub2-mkconfig -o /boot/grub2/grub.cfg
```

**"grub 装了但启动进不去"** → 检查 `/etc/fstab` 与 `/boot/grub2/grub.cfg` 里的 UUID 是否一致。

### ④ 内核层（卡住/panic）

**常见三类**：

```
① 卡在 "Loading Linux ..." → 内核/initramfs 损坏
② 卡在 "dracut-initqueue timeout" → 找不到根设备
③ panic: not syncing: VFS unable to mount root
```

**解决**：

```bash
# 救援盘 chroot 后
dracut -f /boot/initramfs-$(uname -r).img $(uname -r)
# 或进 GRUB 编辑，把 root=UUID=... 改成实际 UUID
blkid   # 查真实 UUID
```

**"改了磁盘/RAID 后起不来"** → 99% 是 UUID 变了，fstab 与 grub 都要改。

### ⑤ 挂载层

**fstab 写错导致起不来**（很常见）：

```
现象：卡在 "A start job is running for ..."（90s 超时）
```

**解决**：

```
① GRUB 加 `rw init=/bin/bash` 或用救援模式
② 把 fstab 里错的行注释
③ 用 `mount -a` 验证后再重启
④ 建议加 `nofail`（非关键挂载）
```

```
UUID=xxx  /data  xfs  defaults,nofail  0 0
```

### ⑥ 服务层（系统起来了但业务不通）

```bash
systemctl --failed
journalctl -b -p err --no-pager
systemctl status nginx
ss -lntp
```

**"系统 up 但 ssh 不通"**：

```
① sshd 起来了吗（systemctl status sshd）
② 防火墙（firewall-cmd --list-all）
③ 监听地址（0.0.0.0 vs 127.0.0.1）
④ SELinux（getenforce）
```

### 文件系统损坏

```
现象：启动时报 "UNEXPECTED INCONSISTENCY"，进 emergency mode
```

```bash
# xfs
xfs_repair -n /dev/sda3      # 先 dry-run
xfs_repair /dev/sda3         # 需卸载

# ext4
fsck -y /dev/sda3
```

**"根分区不能卸载"** → 从救援盘做，别在运行中 fsck。

### 一次"标准动作"的清单

```
1) 记录现象（照片/日志），别急着重启
2) 有 IPMI 先看硬件日志
3) 救援盘启动，挂载 + chroot
4) 按层排查（引导 → 内核 → 挂载 → 服务）
5) 修复后先"只读验证"（mount -a、systemctl --failed）
6) 再重启，并保留修复记录
```

### 常见"起不来"的十条对应表

| 现象 | 首查 |
| --- | --- |
| 卡 loading Linux | initramfs 重建 |
| dracut timeout | 根设备 UUID / 驱动缺失（如 raid 卡） |
| emergency mode | fstab / 文件系统损坏 |
| GRUB 无菜单 | 引导顺序 / ESP |
| 启动后立即重启 | 内核 panic（看 console 输出） |
| 服务全 fail | 磁盘满 / 权限 / SELinux |
| 网络不通 | NetworkManager / 防火墙 |
| 只有单用户能进 | PAM / 磁盘配额 |
| 时间错乱 | NTP / 时区 / 主板电池 |
| 随机重启 | 硬件（内存/电源/温度） |

### 检查清单

```
□ 有 IPMI/带外管理可用
□ 有救援 U 盘/ISO 常备
□ /etc/fstab 关键挂载有 nofail
□ 重要机器有"引导修复"记录（UUID/分区表）
□ 知道 initramfs 重建命令
□ 知道 chroot 修复流程
□ 有硬件错误日志告警
□ 修复前先留证据
□ 修复后做只读验证
□ 有"起不来"的 runbook
```
