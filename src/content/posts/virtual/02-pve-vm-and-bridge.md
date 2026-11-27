---
title: Proxmox VE 上手：装系统、建虚拟机、桥接网络
description: 一台旧电脑就能搭私有云。完整步骤含 ISO 上传、virtio 驱动、vmbr0 桥接与远程访问。
date: 2026-11-22
tags: [虚拟化, PVE, Proxmox, 实验, 私有云]
---

### 为什么拿 PVE 练手

免费、Web 管理、支持 KVM 虚机和 LXC 容器、自带备份与快照、能组集群。对学习和中小企业内网，性价比几乎无对手。

### 1. 装 PVE

1. 官方下载 ISO，用 Rufus / balenaEtcher 写到 U 盘。
2. 目标机 BIOS 里开 VT-x / AMD-V（虚拟化支持），否则虚机会极慢甚至起不来。
3. 安装向导里**管理网卡**选对（后面用 `https://IP:8006` 访问），IP 设成静态。
4. 装完浏览器打开 `https://<IP>:8006`，自签证书会提示不安全，继续即可。

登录后先看两件事：**存储**（local-lvm 有没有）、**网络**（vmbr0 是否存在）。

### 2. 上传 ISO

左侧 `local` → ISO 镜像 → 上传。或者命令行放到 `/var/lib/vz/template/iso/`：

```bash
ls -lh /var/lib/vz/template/iso/
```

### 3. 建一台虚拟机（命令行版更清楚）

```bash
qm create 101 --name web-test --memory 2048 --cores 2 \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-pci \
  --ostype l26

qm importdisk 101 /var/lib/vz/template/iso/ubuntu-22.04.iso local-lvm
qm set 101 --scsi0 local-lvm:vm-101-disk-0
qm set 101 --ide2 local-lvm:vm-101-disk-0,media=cdrom
qm set 101 --boot order=scsi0
qm start 101
```

要点：

- **网卡选 virtio**，性能最好；但 Windows 装的时候要先挂 virtio 驱动 ISO，否则找不到网卡和硬盘。
- **磁盘选 virtio-scsi**，比 IDE 快一个数量级。
- `qm config 101` 随时检查配置有没有写错。

### 4. 网络：理解 vmbr0

```text
物理网卡 eth0  ──┐
                 ├─ vmbr0（虚拟交换机，PVE 默认）
虚机 vnet0     ──┘
```

`vmbr0` 是桥接：虚机像插在同一台交换机上，直接拿局域网 IP。配置在 `/etc/network/interfaces`：

```ini
auto vmbr0
iface vmbr0 inet static
    address 192.168.1.10/24
    gateway 192.168.1.1
    bridge-ports enp3s0
    bridge-stp off
    bridge-fd 0
```

虚机要"内网隔离"时，新建 `vmbr1` 不给网关，只连指定虚机——这就等于一台虚拟交换机。

### 5. 常规运维动作

```bash
qm list                      # 所有虚机与状态
qm snapshot 101 pre-upgrade  # 变更前打快照
qm rollback 101 pre-upgrade  # 出事回滚
qm clone 101 102 --full      # 克隆一台做测试
vzdump 101 --dumpdir /backup --mode snapshot   # 真备份
```

`vzdump` 才是备份；`qm snapshot` 只是同一存储上的状态点。

### 6. 远程访问与安全

- PVE 管理口（8006）**只允许管理网段访问**，别暴露到公网。
- 开启双因素认证（`Datacenter → Permissions → TFA`）。
- 定期 `apt update && apt dist-upgrade`，PVE 是 Debian 底座。

### 常见卡点

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 虚机网络不通 | 桥接选错网卡 | 检查 `bridge-ports` 是否为真实物理网卡 |
| 装 Windows 找不到硬盘 | 缺 virtio 驱动 | 挂载 virtio-win ISO |
| 虚机巨慢 | BIOS 未开虚拟化 | 开 VT-x/AMD-V |
| 存储显示空间不足 | 精简置备/快照占用 | `lvs`、`du` 查快照链 |

### 本章要点

- PVE = Debian + KVM + Web 管理，装完先确认存储与 `vmbr0`。
- 虚机网卡/磁盘一律 virtio，性能差别很大。
- `vzdump` 是备份，`qm snapshot` 是后悔药，别混。
- 管理口绝不直接暴露公网。
