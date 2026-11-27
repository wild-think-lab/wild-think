---
title: RDMA 与 NCCL：多机训练到底快在哪
description: InfiniBand 与 RoCEv2 的差别、PFC 与 ECN 为什么必须配、rdma-shared-device-plugin 怎么把 HCA 给 Pod，以及用 nccl-tests 证明带宽达标。
date: 2026-11-27
tags: [RDMA, InfiniBand, RoCE, NCCL, GPU集群]
---

### 为什么多机训练卡在网络

单卡算力再强，多机训练时梯度同步要走网络。普通 TCP/IP 栈要经过内核多次拷贝，延迟在几十微秒级；RDMA 可以直接读写对端内存，延迟降到 1–2 微秒级，且几乎不吃 CPU。

结论：**多机大模型训练，网络不是"够快就行"，是决定线性加速比的关键。**

### IB 与 RoCEv2

| 维度 | InfiniBand | RoCEv2 |
| --- | --- | --- |
| 硬件 | 专用 HCA + 专用交换机 | 普通网卡（支持 RoCE）+ 以太网交换机 |
| 协议 | IB 原生 | RDMA over UDP/IP |
| 成本 | 高 | 低（复用现有网络） |
| 配置难度 | 低（默认无损） | 高（必须配无损以太网） |
| 典型 | HDR 200Gb/s、NDR 400Gb/s | 100/200Gb |

云上和自建机房里 RoCE 更常见，因为它能复用以太网运维体系；但**"无损"这件事必须自己配**，配不好就会出现丢包导致的性能崩塌。

### RoCE 的关键：无损以太网

RoCEv2 假定网络不丢包。丢一个包，重传代价远大于 TCP——带宽断崖式下跌。

两个机制：

1. **PFC（Priority Flow Control）**：链路层背压，防止缓冲区溢出丢包。
2. **ECN + DCQCN**：端到端拥塞通知，让发送端主动降速。

```bash
# 交换机侧大致要做的（以华为/思科为例，概念通用）
# 1. 为 RDMA 流量划分独立优先级（如 priority 3）
# 2. 在该优先级开启 PFC
# 3. 开启 ECN，配置水线
```

主机侧（以 Mellanox 网卡为例）：

```bash
# 确认 RoCE 模式与固件
mlxconfig -d /dev/mst/mt4123_pciconf0 query | egrep 'LINK_TYPE|ROCE'
mst status

# 关键 sysctl：禁用影响延迟的选项
sysctl -w net.ipv4.tcp_timestamps=0

# 检查 PFC 是否生效
ethtool -a eth0            # 看 RX/TX pause frames
mlnx_qos -i eth0           # 看 prio 与 trust 模式
```

**最常见的性能问题：PFC 只在一侧开启**。单向 PFC 等于没有，必须两端 + 交换机全链路一致。

### 把 RDMA 设备交给 Pod

K8s 里靠 `rdma-shared-device-plugin`（或 SR-IOV 模式的 `sriov-device-plugin`）：

```bash
kubectl apply -f https://raw.githubusercontent.com/Mellanox/rdma-shared-device-plugin/master/deployment.yml
kubectl get nodes -o json | jq '.items[].status.capacity'
# 期望 "rdma/rdma_shared_device_a": "8"
```

Pod：

```yaml
resources:
  limits:
    rdma/rdma_shared_device_a: 1
    nvidia.com/gpu: 8
```

`rdma_shared_device_a` 是共享模式（多个 Pod 共用一个 HCA，靠 QoS 隔离），`rdma_sriov` 是独占 VF 模式（性能更好，需要 SR-IOV 支持）。

容器里验证：

```bash
ibv_devices          # 列出可用 HCA
ibv_devinfo -v | grep -E 'state|link_layer|rate'
# state: PORT_ACTIVE, link_layer: Ethernet (RoCE), rate: 200 Gb/sec
```

`state: PORT_DOWN` 说明链路没起来，先查光模块/交换机端口，不要怀疑训练代码。

### 用 NCCL 证明带宽达标

单机双卡：

```bash
git clone https://github.com/NVIDIA/nccl-tests && cd nccl-tests
make MPI=1 MPI_HOME=/usr/lib/x86_64-linux-gnu/openmpi
./build/all_reduce_perf -b 8 -e 8G -f 2 -g 2
```

多机（两节点各 8 卡）：

```bash
mpirun -np 16 -hostfile hosts.txt \
  -x NCCL_DEBUG=INFO -x NCCL_IB_DISABLE=0 \
  ./build/all_reduce_perf -b 8 -e 8G -f 2 -g 1
```

看结果里的 `Bus bandwidth`：

- 8 卡单机 NVLink：接近 300+ GB/s。
- 双机 200G RoCE：约 20–24 GB/s（每卡）。

**远低于预期**就按顺序查：`NCCL_DEBUG=INFO` 是否走 IB/RoCE（看 `NET/IB` 还是 `NET/Socket`）→ `ibv_devinfo` 链路速率 → PFC 是否双侧开启 → MTU 是否 9000（jumbo）→ 是否走了错误的网卡（多网卡场景常见）。

`NCCL_SOCKET_IFNAME` 用来强制选网卡，能解决"选了管理网"的经典错误。

### 排障顺序（记住这张表）

| 现象 | 先查 |
| --- | --- |
| `ibv_devinfo` PORT_DOWN | 光模块、交换机端口、速率协商 |
| NCCL 日志显示 `NET/Socket` | 容器内没看到 HCA 或 `NCCL_IB_DISABLE=1` |
| 带宽只有 1/3 | PFC 单向、MTU 未调、跨交换机路径拥塞 |
| 训练一段时间后变慢 | 交换机 ECN 未开导致拥塞扩散 |
| 只有某几台慢 | 该机器 HCA 固件/驱动版本不一致 |

### 落地建议

1. 建集群时就把**无损网络**配好并留验证报告（PFC + ECN + MTU）。
2. 每次扩容后跑一遍 `all_reduce_perf`，把带宽数字记进文档。
3. 监控接入 IB 端口错误计数（`perfquery`、`ibdiagnet`），别等训练崩了才查。
4. 别用管理网跑训练流量。

多机训练的性能问题，九成不在代码里，在**网络链路上的某一个配置项**。
