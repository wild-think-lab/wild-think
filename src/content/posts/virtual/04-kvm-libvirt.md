---
title: KVM 与 libvirt：不用面板管理虚拟机
description: 网桥与 NAT 网络怎么选、virt-install 一条命令起机、virsh 日常操作、快照与克隆的差别、控制台进不去怎么救。
date: 2026-11-27
tags: [KVM, libvirt, 虚拟化, Linux]
---

### 为什么还要懂命令行

Proxmox、PVE 面板很好用，但一出问题就只剩 shell。懂 `virsh` 与 `virt-install`，才能在"面板连不上"时救回机器。

### 先确认环境

```bash
egrep -c '(vmx|svm)' /proc/cpuinfo      # >0 表示 CPU 支持虚拟化
lsmod | grep kvm
virsh list --all
virsh version
```

安装（Debian/Ubuntu）：

```bash
apt install -y qemu-kvm libvirt-daemon-system libvirt-clients bridge-utils virtinst
systemctl enable --now libvirtd
```

### 网络：桥接还是 NAT

| | 桥接（bridge） | NAT（默认 default 网络） |
| --- | --- | --- |
| 虚拟机 IP | 与宿主机同网段，局域网可直接访问 | 192.168.122.x 私有段 |
| 对外可见 | 是 | 否，需端口转发 |
| 配置难度 | 需改宿主机网卡 | 开箱即用 |
| 适合 | 服务器、要对外提供服务 | 测试、开发机 |

桥接（Netplan 示例）：

```yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    enp1s0:
      dhcp4: no
  bridges:
    br0:
      interfaces: [enp1s0]
      addresses: [192.168.1.20/24]
      gateway4: 192.168.1.1
      nameservers:
        addresses: [223.5.5.5]
```

改完 `netplan apply`，如果断了就在控制台改回来——这一步远程操作务必先准备好 IPMI/救援。

NAT 端口转发（把宿主机 2222 转到虚机 22）：

```bash
virsh net-list --all
virsh net-dumpxml default
iptables -t nat -A PREROUTING -p tcp --dport 2222 -j DNAT --to 192.168.122.10:22
# 持久化：写进 /etc/libvirt/hooks/qemu 或用 firewalld rich rule
```

### 一条命令起一台机

```bash
virt-install \
  --name web01 \
  --memory 4096 --vcpus 2 \
  --disk path=/var/lib/libvirt/images/web01.qcow2,size=40,format=qcow2,bus=virtio \
  --network bridge=br0,model=virtio \
  --os-variant ubuntu24.04 \
  --cdrom /iso/ubuntu-24.04-live-server-amd64.iso \
  --graphics vnc,listen=127.0.0.1 \
  --console pty,target_type=serial \
  --noautoconsole
```

参数要点：

- `bus=virtio` 与 `model=virtio`：半虚拟化驱动，IO 性能比 IDE/e1000 高一个量级。
- `--os-variant` 决定默认设备与时钟配置，`virt-install --osinfo list` 可查。
- `--noautoconsole` 让命令直接返回，不挂在控制台上。

想用 cloud-init 自动装（更接近生产）：

```bash
cloud-localds seed.iso user-data meta-data
virt-install --name web02 --memory 2048 --vcpus 2 \
  --disk /var/lib/libvirt/images/web02.qcow2,size=30 \
  --disk seed.iso,device=cdrom \
  --import --os-variant ubuntu24.04 --network bridge=br0 --noautoconsole
```

`--import` 表示"镜像是现成的，直接启动"，配合 cloud-init 镜像最省事。

### virsh 日常

```bash
virsh list --all
virsh start web01
virsh shutdown web01           # ACPI 优雅关机
virsh destroy web01            # 强制断电（等于拔电源）
virsh reboot web01
virsh suspend web01 / resume web01
virsh dominfo web01
virsh domblklist web01
virsh domiflist web01
virsh vcpuinfo web01
virsh setmem web01 8G --live   # 热调内存（需 guest 支持）
virsh setvcpus web01 4 --live
```

`destroy` 名字很迷惑，它是"立即停止"，不是"删除"。删机器是 `virsh undefine`（加 `--remove-all-storages` 才删磁盘）。

### 快照与克隆，别搞混

**快照（snapshot）**：同一台机器的某个时间点状态，存在同一个磁盘文件里。

```bash
virsh snapshot-create-as web01 before-upgrade --description "升级前"
virsh snapshot-list web01
virsh snapshot-revert web01 before-upgrade
virsh snapshot-delete web01 before-upgrade
```

注意：qcow2 快照越多，读性能越差（链式回溯）。**长期依赖快照是坏习惯**，正式做法是克隆或备份。

**克隆（clone）**：复制出一台新机器。

```bash
# 需要先关机或做完整备份
virt-clone --original web01 --name web02 --file /var/lib/libvirt/images/web02.qcow2
```

克隆后必须改：主机名、IP、machine-id、SSH host key。否则同网段会出现 IP/MAC 冲突，SSH 会报 host key 变更。

```bash
rm /etc/machine-id && systemd-machine-id-setup
rm /etc/ssh/ssh_host_*
ssh-keygen -A
```

### 控制台进不去怎么救

VNC 只能从本机访问时，用 SSH 隧道：

```bash
ssh -L 5901:127.0.0.1:5901 root@host
# 然后 VNC 客户端连 localhost:5901
```

或者用串口（需 guest 配置 `console=ttyS0`）：

```bash
virsh console web01        # 退出用 Ctrl + ]
```

进不去的最常见原因是 guest 没配串口，或 `--console pty` 没加。已经装好的机器可以临时加：

```bash
virsh edit web01
# 在 <devices> 里加：<serial type='pty'><target port='0'/></serial>
```

### 性能三个开关

```xml
<!-- 1. 磁盘用 virtio-blk 或 virtio-scsi + cache=none -->
<driver name='qemu' type='qcow2' cache='none' io='native'/>

<!-- 2. 网卡用 virtio + 多队列 -->
<driver name='vhost' queues='4'/>

<!-- 3. CPU 直通模式，减少陷出 -->
<cpu mode='host-passthrough'/>
```

判断是否缺 vhost：虚机内 `ethtool -S eth0 | grep -i queue`，以及宿主机 `top` 里 `vhost` 线程是否在跑。

### 一句话总结

面板给你便利，`virsh` 给你退路。**桥接选 br0、磁盘选 virtio+cache=none、快照别当备份**，这三条记住就能少踩大半坑。
