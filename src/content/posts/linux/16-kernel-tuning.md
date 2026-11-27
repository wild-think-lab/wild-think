---
title: Linux 内核参数调优：八个真有用的参数与一堆没用的
description: 网络、文件句柄、内存、TIME_WAIT，每个参数的实际作用、默认值、推荐值与"调错了会怎样"。
date: 2026-11-27
tags: [Linux, 内核, 性能调优]
---

### 先立个规矩

```
不要抄"网上的一百项内核优化"
每一项都要能回答：解决什么问题、代价是什么、如何验证
```

**大多数"优化清单"是把别人的场景硬套到你的场景**。

### 网络：连接队列（最重要）

```bash
# 全连接队列（accept queue）
net.core.somaxconn = 65535          # 默认 4096（较新内核）
# listen backlog 要跟上（应用侧）

# 半连接队列（SYN queue）
net.ipv4.tcp_max_syn_backlog = 8192  # 默认 128/1024

# SYN cookies（极端情况下防 SYN Flood）
net.ipv4.tcp_syncookies = 1
```

**为什么重要**：

```
高并发下队列满 → 内核丢 SYN → 客户端重试 → 表现为"连不上/超时"
```

**验证**：

```bash
netstat -s | grep -E "listen|overflow|SYNs to LISTEN"
ss -lnt   # 看 Send-Q 与 Recv-Q（Recv-Q 是 backlog 里的等待数）
```

**`ss -lnt` 的 Recv-Q 持续 > 0** → backlog 不够。

### 网络：TIME_WAIT

```bash
net.ipv4.tcp_tw_reuse = 1           # 允许复用 TIME_WAIT（作为客户端）
net.ipv4.tcp_fin_timeout = 30       # 默认 60
net.ipv4.ip_local_port_range = "1024 65535"   # 临时端口范围
```

**TIME_WAIT 为什么存在**：

```
保证最后一个 ACK 能到达（防旧连接的数据混入新连接）
```

**不要做的事**：

```
① 不要设 tcp_tw_recycle（Linux 4.12 已移除，NAT 下会出错）
② 不要为了"减少 TIME_WAIT"缩短 fin_timeout 到 1
③ 不要无脑开 tcp_tw_reuse 在服务端（它主要对客户端有用）
```

**TIME_WAIT 太多的真正解法**：

```
① 用长连接（keepalive）而不是短连接
② 客户端换端口范围（多 IP）
③ 服务端用 SO_REUSEPORT
```

```bash
# 统计
ss -s | grep TIME-WAIT
ss -tan state time-wait | wc -l
```

### 网络：缓冲区

```bash
net.core.rmem_max = 16777216        # 接收缓冲上限
net.core.wmem_max = 16777216        # 发送缓冲上限
net.ipv4.tcp_rmem = "4096 87380 16777216"
net.ipv4.tcp_wmem = "4096 65536 16777216"
```

**什么时候需要调大**：

```
① 高带宽 × 高延迟链路（BDP 大）
② 大文件传输
```

**代价**：内存占用上升（每个连接都可能用满）。

**验证**：

```bash
ss -tmn    # 看每个连接的 rcv/snd buffer
```

**"带宽跑不满"常见原因就是缓冲不够**（尤其跨国链路）。

### 文件句柄

```bash
fs.file-max = 2097152                     # 系统级
# 进程级用 ulimit / limits.conf
```

```bash
# /etc/security/limits.conf
*  soft nofile 65535
*  hard nofile 65535
```

**注意"systemd 服务不受 limits.conf 约束"**：

```ini
# 在 unit 里写
[Service]
LimitNOFILE=65535
```

**这是"改了 limits.conf 但服务还是 too many open files"的原因**。

### 内存

```bash
vm.swappiness = 1                    # 尽量不用 swap（数据库/中间件机器）
vm.overcommit_memory = 1             # Redis 官方建议（避免 fork 失败）
vm.max_map_count = 262144            # Elasticsearch 必需
```

**逐个说清**：

```
swappiness         ：0 是最"不换出"，但 1 更安全（保留一点应急 swap）
overcommit_memory  ：1 = 总是允许超额分配（Redis bgsave fork 需要）
max_map_count      ：mmap 区域上限（ES/Lucene 需要大量 mmap）
```

**`vm.overcommit_memory=1` 的风险**：

```
可能 OOM killer 突然杀进程（因为允许超额）
→ 只在对的应用上开，且保证有足够物理内存
```

### 脏页回写

```bash
vm.dirty_ratio = 10                  # 默认 20（脏页占比上限，超过就同步写）
vm.dirty_background_ratio = 5        # 默认 10（后台开始回写）
vm.dirty_expire_centisecs = 3000     # 脏页存活时间
```

**调小的影响**：

```
写延迟更平稳（不会出现"突然卡住几十秒"）
写吞吐略降
```

**"磁盘 IO 周期性卡顿"往往与脏页回写有关**。

### 要谨慎/不要动的

```
① net.ipv4.tcp_timestamps = 0  → 一般不要关（影响 RTT 测量与 PAWS）
② kernel.pid_max  → 一般不需要改
③ vm.min_free_kbytes  → 除非明确知道，不要改
④ net.ipv4.tcp_slow_start_after_idle = 0 → 长连接场景有益，但要验证
```

**"tcp_timestamps=0" 的传说来自老内核**，现代内核不需要关。

### 怎么"正确"地调

**四步法**：

```
① 建立基线（压测 + 监控，记录当前指标）
② 只改一个参数
③ 再压测，对比指标
④ 有改善才保留，否则回滚
```

**没有基线的调优是玄学**。

### 一个可直接用的"Web 服务"配置

```bash
# /etc/sysctl.d/99-web.conf
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = "1024 65535"
net.ipv4.tcp_fin_timeout = 30
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = "4096 87380 16777216"
net.ipv4.tcp_wmem = "4096 65536 16777216"
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 3
fs.file-max = 2097152
vm.swappiness = 1
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5
```

```bash
sysctl --system
```

**注意**：

```
① 不要直接在生产 apply（先在测试压测）
② 记录变更（哪个参数、为什么、验证结果）
③ 不同角色（Web/DB/缓存）用不同文件（99-web.conf / 99-db.conf）
```

### 检查清单

```
□ 有压测基线再谈调优
□ somaxconn 与 listen backlog 对齐
□ 用 ss 看 backlog 与 TIME_WAIT
□ 高带宽链路调大 tcp_rmem/wmem
□ systemd 服务的 LimitNOFILE 单独设
□ 数据库机器 swappiness 调低
□ ES 机器 max_map_count 调大
□ 脏页回写参数按"延迟稳定性"取舍
□ 不抄网上的百项优化
□ 每次只改一个参数并复测
□ 参数按角色分文件，有变更记录
```
