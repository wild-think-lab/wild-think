---
title: Linux 启动故障：从"开不了机"到"能进系统"
description: GRUB 与 initramfs 的作用、四种启动失败的定位、救援模式实操、以及"改配置把自己锁死"的恢复路径。
date: 2026-11-27
tags: [Linux, 启动, GRUB, 救援, 排障]
---

### 启动的四个阶段

```
① 固件（BIOS/UEFI）→ 找启动设备
② GRUB → 加载内核与 initramfs
③ 内核 → 挂载根文件系统、启动 init
④ systemd → 按 target 启动服务
```

每一阶段失败的表现不同，**先判断停在哪一阶段**，再针对性修。

| 现象 | 停在 | 典型原因 |
| --- | --- | --- |
| 黑屏无输出、找不到设备 | ① | 启动顺序错、硬盘掉线、UEFI 引导项丢失 |
| `grub rescue>` 提示 | ② | GRUB 配置找不到、分区号变了 |
| 卡在 `Loading initial ramdisk` 或 kernel panic | ③ | initramfs 缺驱动、根分区找不到、fstab 错 |
| 卡在 `Reached target Basic System` | ④ | systemd 单元失败、服务 hang |

### 阶段二：GRUB rescue

看到 `grub rescue>` 说明 GRUB 本体在，但找不到配置文件或 `/boot`。

```bash
grub rescue> ls                       # 列出磁盘
grub rescue> ls (hd0,1)/              # 看分区内容
grub rescue> ls (hd0,msdos1)/boot/grub   # 找 grub.cfg

grub rescue> set root=(hd0,msdos1)
grub rescue> set prefix=(hd0,msdos1)/boot/grub
grub rescue> insmod normal
grub rescue> normal
```

进系统后立刻修：

```bash
sudo grub-install /dev/sda
sudo update-grub          # Debian/Ubuntu
sudo grub2-mkconfig -o /boot/grub2/grub.cfg   # RHEL
```

**最常见原因**：换过硬盘、调整过分区、克隆后 UUID 变了。

### 阶段三：内核 panic 与根分区找不到

提示：

```
VFS: Unable to mount root fs on unknown-block(0,0)
```

三种原因：

1. **initramfs 缺存储驱动**（换了 RAID 卡/虚拟化平台后常见）。
2. **fstab 里的 UUID 不存在**（磁盘换了）。
3. **根分区损坏**（需要 fsck）。

在 GRUB 菜单按 `e` 编辑启动项，临时加参数：

```
root=/dev/sda1            # 用设备名替代 UUID
ro                        # 只读挂载，便于 fsck
break=init                # 进入 initramfs shell（Debian 系）
rd.break                  # RHEL 系进入 initramfs shell
```

进去后：

```bash
# 看有哪些盘
ls /dev/sd*
blkid
# 尝试挂载
mount /dev/sda1 /mnt
cat /mnt/etc/fstab
```

### 阶段四：systemd 卡住

```bash
systemctl --failed
journalctl -b -p err
journalctl -b -u <service>
```

常见卡点：

| 单元 | 典型问题 |
| --- | --- |
| `systemd-remount-fs` | fstab 有错行 |
| `local-fs.target` | 挂载超时（NFS 不可达） |
| `network-online.target` | 网络配置错，等待超时 |
| 某个 service | 启动脚本 hang（无超时） |

快速绕过：GRUB 加 `systemd.unit=multi-user.target` 或 `emergency`，或者 `systemd.mask=xxx.service`。

### 救援模式：最实用的三条路径

**① GRUB 加 `single` 或 `S`**

```
linux ... ro single
```

进入单用户（root shell，无网络），适合改 fstab、改 sshd 配置。

**② 发行版救援模式**

- RHEL/CentOS：安装盘 → Troubleshooting → Rescue a ... system
- Ubuntu：Live CD/USB 启动 → `chroot`

```bash
# chroot 修复流程
mount /dev/sda2 /mnt
mount --bind /dev /mnt/dev
mount --bind /proc /mnt/proc
mount --bind /sys /mnt/sys
chroot /mnt
# 现在可以重装 grub、改配置、修 fstab
```

**③ initramfs shell**（`rd.break`）

适合修"根分区找不到"与"忘记 root 密码"。

### 忘记 root 密码

```
GRUB 编辑 → 内核行末尾加 rd.break → Ctrl-x 启动
```

```bash
mount -o remount,rw /sysroot
chroot /sysroot
passwd root
# SELinux 系统必须做下面这步，否则重启后登不上
touch /.autorelabel
exit; exit
```

`.autorelabel` 这一步漏掉，SELinux 会因上下文不对而拒绝登录——这是最经典的"改了密码还是进不去"。

### fstab 写错导致起不来

这是最高频的"自己搞自己"。

预防：

```bash
mount -a          # 改完 fstab 先验证，不报错再重启
```

修复：救援模式进去，把错的那行注释掉（行首 `#`）。

**NFS 挂载一定要加选项**：

```
server:/export /mnt nfs defaults,soft,timeo=10,retrans=3 0 0
```

`hard` 默认会在 NFS 不可达时永久 hang，导致开机卡死。

### 改 sshd_config 把自己锁外面

```bash
sshd -t                      # 先测语法
# 如果有错，先修好再 reload
systemctl reload sshd
```

已经锁外面时的补救：

1. 云主机：用控制台的 VNC/串口。
2. 物理机：本地键盘，或救援模式。
3. 有 IPMI/iDRAC：远程 KVM。

预防：改 sshd 前保留当前会话，用另一个窗口测试新连接，成功了再退出旧会话。

### 一次真实的启动事故复盘

现象：虚拟化平台迁移后，VM 卡在 `Loading initial ramdisk` 之后 kernel panic。

排查：

1. 平台从 VMware 迁到 KVM，磁盘控制器从 `LSI Logic` 变成 `virtio`。
2. 原机的 initramfs 只包含 `mptspi` 驱动，没有 `virtio_blk`。
3. 内核启动后找不到根盘 → panic。

修法：

```bash
# 救援模式 chroot 进去，重建 initramfs 并加入 virtio
chroot /mnt
# Debian 系
echo "virtio_blk" >> /etc/initramfs-tools/modules
update-initramfs -u -k all
# RHEL 系
dracut --force --add-drivers "virtio_blk virtio_scsi"
```

教训：**换虚拟化平台/主板/RAID 卡之前，先确认 initramfs 包含新硬件驱动**。这个坑每次迁移都会有人踩。

### 检查清单（重要变更前）

```
□ /boot 有至少 200MB 空闲（内核更新会占满）
□ 保留至少一个可用的旧内核启动项
□ fstab 改完执行过 mount -a
□ sshd/config 改完执行过语法检查
□ 有控制台访问方式（VNC/IPMI/云控制台）
□ 最近一次可用的备份时间明确
```
