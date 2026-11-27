---
title: sysctl 与内核参数：哪些该调，哪些别碰
description: 网络、文件句柄、内存、TIME_WAIT 的实际影响与推荐值，配一个能直接落地的 sysctl.d 文件，以及"调了反而更慢"的四个坑。
date: 2022-05-06
tags: [Linux, 内核参数, 性能, 运维]
---

### 先说结论：90% 的参数不需要动

现代内核的默认值已经相当合理。真正需要调的只有四类：

1. 文件句柄与服务并发
2. 网络连接的队列与端口范围
3. 内存与 swap 倾向
4. 特定场景（如高并发短连接、大量容器）

调之前先看现状：

```bash
sysctl -a | grep -E 'somaxconn|tcp_max_syn|ip_local_port_range|file-max'
ulimit -n
cat /proc/sys/net/core/somaxconn
```

### 推荐的一份 sysctl.d

```ini
# /etc/sysctl.d/99-tuning.conf
# ---- 文件与进程 ----
fs.file-max = 2097152

# ---- 网络：连接队列 ----
net.core.somaxconn = 32768              # accept 队列上限（Nginx/Tomcat backlog 受它限制）
net.ipv4.tcp_max_syn_backlog = 8192     # SYN 队列
net.ipv4.tcp_abort_on_overflow = 0      # 队列满时不 RST，让客户端重试（默认就好）

# ---- 网络：端口与复用 ----
net.ipv4.ip_local_port_range = 10240 65000
net.ipv4.tcp_tw_reuse = 1               # 允许复用 TIME_WAIT（仅出向连接）
net.ipv4.tcp_fin_timeout = 30

# ---- 网络：TIME_WAIT 与内存 ----
net.ipv4.tcp_max_tw_buckets = 262144
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# ---- 内存 ----
vm.swappiness = 10                       # 尽量不用 swap（数据库机上常设 1）
vm.overcommit_memory = 1                 # Redis 建议设 1，避免 fork 失败
vm.max_map_count = 262144                # ES / 大量 mmap 场景需要

# ---- 连接跟踪（做 NAT/防火墙的机器） ----
net.netfilter.nf_conntrack_max = 1048576
```

写入后：

```bash
sysctl --system
sysctl net.core.somaxconn
```

`sysctl --system` 按文件名顺序加载 `/etc/sysctl.d/*.conf`，`99-` 放最后以确保覆盖。

### 四个最常被调错的参数

**① `net.core.somaxconn` 单独调没用。**
它是"内核的 accept 队列上限"，但应用自己的 backlog 也要跟上：

```nginx
listen 80 backlog=32768;
```

Tomcat 的 `acceptCount`、Go 的 `http.Server` 默认已经足够。只调内核不调应用，等于罐口开大了但瓶口没动。

**② `tcp_tw_recycle` 千万别开。**
它在 NAT 环境下会误杀连接（同一个公网 IP 的不同客户端时间戳不同），表现为"部分用户间歇性连不上"。这个参数在新内核里已被移除，老系统上看到有人开，直接关掉。

**③ `vm.swappiness=0` 不等于"不用 swap"。**
设 0 在部分内核版本上会导致 OOM 时更激进地杀进程。数据库机器用 1 或 10 更稳。

**④ `fs.file-max` 调了但 `ulimit` 没调。**
`fs.file-max` 是系统级上限，进程级还受 `ulimit -n` 与 systemd 的 `LimitNOFILE` 限制。三层都要放开：

```ini
# /etc/systemd/system.conf 与对应 service
DefaultLimitNOFILE=65535
```

### 如何验证"调对了"

```bash
# 队列是否溢出（overflow 增长说明 accept 跟不上）
nstat -az | grep -i -E 'ListenOverflows|ListenDrops|SyncookiesSent'

# 连接跟踪是否吃满
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# 端口耗尽
ss -s | grep -i time-wait
cat /proc/sys/net/ipv4/ip_local_port_range
```

`ListenOverflows` 持续增长 → 调 `somaxconn` + 应用 backlog。
`SyncookiesSent` 大量出现 → SYN 队列不够或遭受 SYN Flood。
`nf_conntrack: table full` → 调大 `nf_conntrack_max` 或减少 NAT 使用。

### 容器环境的额外注意

容器共享宿主内核，但 `net.*` 命名空间参数是隔离的（每个 Pod 一份），`vm.*`、`fs.file-max` 是全局的。

所以：

- Pod 内调 `net.core.somaxconn` 有用（走 `securityContext.sysctls` 或 initContainer）；
- Pod 内调 `vm.swappiness` 无效（全局参数，改了会影响整台机器）。

```yaml
securityContext:
  sysctls:
  - name: net.core.somaxconn
    value: "32768"
```

### 一句话总结

内核参数调优的正确姿势是**先量指标、再改一项、再看指标**。一次改二十个参数，出了问题你永远不知道是哪个造成的。
