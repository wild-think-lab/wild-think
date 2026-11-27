---
title: GPU 直通与虚拟化：vfio 到底在做什么
description: 直通、SR-IOV、vGPU 三种方式的差别、最小可跑配置、以及五个"直通之后虚拟机起不来"的原因。
date: 2026-11-27
tags: [虚拟化, GPU, vfio]
---

### 三种让虚拟机用上 GPU 的方式

| 方式 | 原理 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 直通（Passthrough） | 整块卡给一台 VM | 性能接近物理机 | 一台 VM 独占一张卡 |
| SR-IOV（vGPU/MIG 类） | 硬件切分成多个 VF | 一卡多 VM | 需要卡支持、配置复杂 |
| 软件 vGPU | 驱动层虚拟化 | 灵活 | 需授权（NVIDIA vGPU 许可） |

**"一台 VM 独占一张卡"就够 → 直通最简单**。

### 直通的最小配置（KVM/libvirt）

**① 开启 IOMMU**

```bash
# Intel
sed -i 's/GRUB_CMDLINE_LINUX="/GRUB_CMDLINE_LINUX="intel_iommu=on iommu=pt /' /etc/default/grub
# AMD: amd_iommu=on
grub2-mkconfig -o /boot/grub2/grub.cfg
reboot
```

验证：

```bash
dmesg | grep -i -E "DMAR|IOMMU enabled"
```

**② 绑定 vfio 驱动**

```bash
# 找设备
lspci -nn | grep -i nvidia
# 例：01:00.0 VGA [0300] / 01:00.1 Audio

# 加入 vfio
cat >> /etc/modprobe.d/vfio.conf <<EOF
options vfio-pci ids=10de:1b80,10de:10f0
softdep nvidia pre: vfio-pci
EOF

# 或者直接开机绑定（更可靠）
echo "vfio-pci" > /etc/modules-load.d/vfio.conf
dracut -f
reboot
```

**③ 确认已绑定**

```bash
lspci -k -s 01:00.0
# Kernel driver in use: vfio-pci
```

**④ 虚拟机配置**

```xml
<hostdev mode='subsystem' type='pci' managed='yes'>
  <source>
    <address domain='0x0000' bus='0x01' slot='0x00' function='0x0'/>
  </source>
</hostdev>
```

**注意**：

```
显卡的"音频功能"（function 0x1）通常要一起直通
否则驱动可能装不上或报错
```

### 五个"直通之后起不来"的原因

**① IOMMU 没开 / 平台不支持**

```
dmesg 无 "DMAR" → 主板/BIOS 未开 VT-d
→ 需要在 BIOS 里开启 VT-d / IOMMU
```

**② 设备被宿主机驱动占用**

```
nvidia 驱动先加载 → vfio 抢不到
→ 用 softdep 让 vfio-pci 先加载
```

**③ IOMMU 分组太大**

```
一块卡与别的设备在同一 IOMMU group → 必须一起直通
→ 换 PCIe 插槽 / 用 ACS override（有风险）
```

```bash
for d in /sys/kernel/iommu_groups/*; do
  echo "IOMMU Group ${d##*/}:"
  for dev in $d/devices/*; do lspci -n -s $(basename $d/devices/*); done
done
```

**④ 宿主机没有 UEFI/OVMF**

```
老式 BIOS 直通显卡常失败
→ 用 UEFI（OVMF）+ q35 机型
```

**⑤ 虚拟机里装的是"消费级卡 + 服务器系统"**

```
部分消费卡在虚拟化环境驱动拒绝加载
→ 需要厂商特定方案（或换专业卡）
```

### SR-IOV（一卡多 VM）

```bash
# 开启 VF
echo 4 > /sys/class/net/eth0/device/sriov_numvfs

# GPU 的 SR-IOV 需要卡与驱动都支持（如 A100/MIG、部分专业卡）
nvidia-smi mig -cgi 1g.5gb -C    # MIG 切分
```

**MIG** 是 NVIDIA 的硬件切分方案（A100/H100）：

```
一卡切 7 个实例 → 7 个容器/VM 各用一个
```

### 性能与注意

```
① 直通性能 ≈ 物理机（几乎无损耗）
② 直通后宿主机看不到该卡（不能同时用）
③ 热迁移不可用（有直通设备的 VM 通常不能迁移）
④ 显卡显存不足时，多 VM 会互相影响（vGPU 场景）
```

**"要热迁移"就别直通**（这是架构级取舍）。

### 检查清单

```
□ BIOS 开 VT-d/IOMMU
□ 内核参数 intel_iommu=on / amd_iommu=on
□ dmesg 确认 DMAR 与 IOMMU enabled
□ 设备已绑定 vfio-pci
□ 音频 function 一起直通
□ IOMMU group 确认（必要时换插槽）
□ 用 UEFI/OVMF + q35
□ 宿主机驱动不抢占（softdep）
□ 明确"不能热迁移"的代价
□ 直通后做一次压力测试（跑训练/推理基准）
```
