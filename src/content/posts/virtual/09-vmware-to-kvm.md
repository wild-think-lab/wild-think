---
title: 从 VMware 迁到 KVM：一份能照着做的迁移方案
description: 为什么要迁、三种迁移方式（在线/离线/在线热迁）、磁盘格式转换、驱动与网络适配、以及迁移后的验证清单。
date: 2024-01-05
tags: [虚拟化, KVM, 迁移, VMware]
---

### 为什么迁

```
① 授权成本（vSphere 按 CPU/核 收费，且逐年涨）
② 国产化/信创要求
③ 想统一到开源栈（Proxmox/KubeVirt/OpenStack）
```

**但也有不该迁的**：

```
① 用了 vSphere 独有能力（DRS/FT/vMotion 跨机房）
② 有大量 Windows 老系统（驱动兼容麻烦）
③ 团队只熟 VMware
```

### 三种迁移方式

| 方式 | 停机 | 复杂度 | 适用 |
| --- | --- | --- | --- |
| 离线（关机拷贝磁盘） | 长（分钟到小时） | 低 | 小规模、可停机 |
| 在线（增量同步后切换） | 短（分钟） | 中 | 大多数场景 |
| 在线热迁（vMotion 类似） | 几乎为零 | 高 | 关键业务 |

**推荐顺序**：先离线迁几台验证流程 → 再做在线迁移。

### 离线迁移（最可控）

**步骤**：

```bash
# 1. 在 VMware 里关机
# 2. 导出磁盘（vmdk）
# 3. 转成 qcow2（KVM 常用格式）
qemu-img convert -p -O qcow2 disk.vmdk disk.qcow2

# 4. 检查信息
qemu-img info disk.qcow2
```

**注意 vmdk 的两种形态**：

```
单文件（-flat.vmdk + 描述文件）
多文件（-s001.vmdk, -s002.vmdk...）
→ 多文件要先合并：vmware-vdiskmanager -r disk.vmdk -t 0 merged.vmdk
```

### 在线迁移（用 virt-v2v）

**`virt-v2v` 是官方工具，专门做"VMware → KVM"**：

```bash
# 从 vCenter 直接拉（无需关机）
virt-v2v -i vmx -it vddk \
  -o libvirt -os /var/lib/libvirt/images \
  -op /var/lib/libvirt/images \
  "vpx://user@vcenter.example.com/Datacenter/esxi1/VMName"

# 或从导出的 vmx 目录
virt-v2v -i vmx -o libvirt -os /var/lib/libvirt/images /path/to/vm.vmx
```

**`virt-v2v` 自动做的事（这是它最大的价值）**：

```
① 转换磁盘格式（vmdk → qcow2/raw）
② 移除 VMware Tools，安装 virtio 驱动
③ 改网卡配置（从 e1000 改成 virtio）
④ 改 grub/内核参数（适配 virtio 磁盘）
⑤ 改 Windows 的注册表（关键！否则蓝屏）
```

**如果没有 `virt-v2v` 手工迁移，Windows 大概率蓝屏**（INACCESSIBLE_BOOT_DEVICE），因为启动时加载的是 LSI 控制器驱动。

### 手工迁移 Windows 的关键步骤

**必须提前装 virtio 驱动**：

```
① 在 VMware 里给 Windows 装 virtio-win 驱动（Red Hat 提供 ISO）
② 关键：把 viostor（磁盘）与 netvios（网卡）设为"启动时加载"
   sc config viostor start= boot
③ 关机 → 迁磁盘 → KVM 里用 virtio 磁盘启动
```

**如果已经蓝屏了**：

```
进恢复模式 → 用 DISM 注入驱动
或挂载磁盘到另一台 VM，用离线注册表修改
```

**建议：先在测试环境迁一台 Windows，验证流程再批量做。**

### KVM 侧的定义

```xml
<domain type='kvm'>
  <name>app01</name>
  <memory unit='GiB'>8</memory>
  <vcpu>4</vcpu>
  <os>
    <type arch='x86_64'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features>
    <acpi/><apic/>
  </features>
  <cpu mode='host-passthrough'/>     <!-- 性能最好 -->
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' cache='none' io='native'/>
      <source file='/var/lib/libvirt/images/app01.qcow2'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <interface type='bridge'>
      <source bridge='br0'/>
      <model type='virtio'/>
    </interface>
    <graphics type='vnc' port='-1' listen='0.0.0.0'/>
  </devices>
</domain>
```

**`cache='none'` + `io='native'`** 是性能最佳组合（直通到宿主 page cache 与 Linux AIO）。

**`cpu mode='host-passthrough'`** 让 VM 看到宿主的完整 CPU 特性（性能最好，但不能热迁移到不同 CPU 的宿主）。

### 网络适配

```
VMware：分布式交换机 / 标准交换机（vSwitch）
KVM：Linux bridge / OVS / macvtap
```

**最简做法（Linux bridge）**：

```bash
# 建桥（用 nmcli，比手写配置安全）
nmcli con add type bridge ifname br0
nmcli con add type bridge-slave ifname eth0 master br0
nmcli con mod br0 ipv4.addresses 10.0.0.5/24
nmcli con mod br0 ipv4.gateway 10.0.0.1
nmcli con mod br0 ipv4.dns 10.0.0.1
nmcli con mod br0 ipv4.method manual
nmcli con up br0
```

**注意**：桥接后宿主 IP 要配在 `br0` 上，不能留在 `eth0`（否则断网）。

**远程操作时**：改网络前先准备好 IPMI/带外，或用 `nmcli` 的"自动回滚"（60 秒内没确认就恢复）。

### 迁移后的验证清单

```bash
# 1. VM 能启动
virsh list --all
virsh start app01

# 2. 控制台能进（VNC）
virsh vncdisplay app01

# 3. 网络通
virsh domiflist app01
# 在 VM 内：ip addr / ping 网关

# 4. 磁盘正常
# 在 VM 内：df -h / mount / dmesg | grep -i virtio

# 5. 性能对比（关键）
# 迁移前在 VMware 里跑一次基准，迁移后跑同样的一次
fio --name=rw --rw=randread --size=1G --bs=4k --iodepth=32 --numjobs=4 --runtime=60
```

**性能对比是必须的**：虚拟化层换了，磁盘/网络性能可能有 10%–30% 的差异。

**如果性能下降明显，检查**：

```
① 磁盘是否用了 virtio（而不是 ide/sata）
② cache 模式（none/writeback/unsafe）
③ CPU 是否 host-passthrough
④ 网卡是否 virtio（e1000 性能差很多）
⑤ 宿主是否开了 CPU 节能（影响性能）
```

### 常见问题

| 问题 | 原因 | 处理 |
| --- | --- | --- |
| Windows 蓝屏（INACCESSIBLE_BOOT_DEVICE） | 缺 virtio 磁盘驱动 | 提前装驱动并设为 boot 加载 |
| Linux 起不来（找不到根分区） | 内核没 virtio_blk | 用 initramfs 加 virtio 模块 |
| 网络不通 | 网卡型号变了（MAC 变了） | 更新 udev 规则 / 配置文件 |
| IP 变了 | DHCP 按 MAC 分配 | 保留原 MAC（`<mac address=...>`） |
| 时间不准 | kvm-clock 未启用 | `<timer name='hpet'/>` + 装 chrony |
| 性能差 | 用了 ide/sata 或 e1000 | 改 virtio |

**"保留原 MAC"很重要**：否则 DHCP/交换机 ACL/授权都可能失效。

```xml
<interface type='bridge'>
  <mac address='00:50:56:aa:bb:cc'/>
  ...
</interface>
```

### 检查清单

```
□ 先迁 1–2 台验证完整流程
□ Windows 提前装 virtio 驱动并设 boot 加载
□ Linux 确认 initramfs 含 virtio_blk
□ 磁盘用 virtio + cache=none + io=native
□ 网卡用 virtio + 保留原 MAC
□ 桥接后宿主 IP 配在 br0
□ 远程改网络有回滚机制
□ 迁移前后跑同一基准对比性能
□ 验证：启动/控制台/网络/磁盘/dmesg
□ 保留原 VM 快照至少一周（可回退）
```
