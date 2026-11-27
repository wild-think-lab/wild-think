---
title: TCP 十一种状态：卡在哪一步能看出来
description: 状态机速读、ss 输出怎么判、五个"连接卡住"的真实原因，以及 TIME_WAIT 到底要不要调。
date: 2025-06-15
tags: [网络, TCP, 排障]
---

### 一条连接的一生

```
CLOSED → LISTEN（服务端）
SYN_SENT（客户端已发 SYN）
SYN_RCVD（服务端已回 SYN,ACK）
ESTABLISHED（三次握手完成）
FIN_WAIT1 → FIN_WAIT2 → TIME_WAIT（主动关闭方）
CLOSE_WAIT → LAST_ACK → CLOSED（被动关闭方）
```

**"卡在哪个状态"** 直接指向问题所在。

### ss 的实用参数

```bash
ss -tan                 # 所有 TCP 连接
ss -ltnp                # 监听端口 + 进程
ss -tan state time-wait | wc -l
ss -tan state close-wait
ss -tan state syn-recv
ss -s                   # 汇总统计
```

**`-i` 看详细（拥塞窗口/重传）**：

```bash
ss -ti dst 10.0.0.5
```

输出里重点看：

```
rtt      ：往返延迟
retrans  ：重传次数（>0 就说明丢包）
cwnd     ：拥塞窗口（小说明被限）
```

### 五种"卡住"的诊断

**① 大量 SYN_RCVD**

```
服务端半开连接堆积 → SYN flood 或 应用 accept 慢
→ 检查 syn backlog 与 somaxconn
```

```bash
sysctl net.ipv4.tcp_max_syn_backlog net.core.somaxconn
```

**② 大量 CLOSE_WAIT**

```
被动关闭方"收到 FIN 但没有 close()"
→ 应用 bug：忘了关连接（连接泄漏）
```

**"CLOSE_WAIT 持续增长"** = 应用没关连接，不是内核问题。

**③ 大量 TIME_WAIT**

```
主动关闭方等待 2×MSL（默认 60s）
→ 高并发短连接必然有
```

**是否需要调**：

```
① 用长连接（连接池）→ 根本不产生
② tcp_tw_reuse=1（对"出向连接"有效，安全）
③ 不要用 tcp_tw_recycle（NAT 下有害，已被移除）
```

**"TIME_WAIT 多"通常不是故障，是现象**。

**④ ESTABLISHED 很多但吞吐低**

```
可能是"连接很多但空闲"（keepalive 太短/客户端池太大）
→ 看 ss -ti 的 rtt/cwnd
```

**⑤ FIN_WAIT2 卡住**

```
对端没回 FIN（应用层没关）
→ 会一直等到超时（tcp_fin_timeout）
```

### 五个"连接卡住"的真实原因

**① 中间设备 session 表满**

```
防火墙/NAT 连接表满 → 新连接建不起来/老连接被丢
→ 表现为"随机不通"
```

**② MTU 不一致**

```
握手正常（小包），传数据卡住（大包被丢）
```

**③ 队头阻塞/丢包**

```
rtt 正常但 retrans 高 → 链路质量差
```

**④ 应用 accept 慢**

```
listen backlog 溢出 → SYN 被丢 → 客户端重传
```

**⑤ 半开连接（NAT 超时）**

```
NAT 把空闲连接表项删了，但两端以为还连着
→ keepalive 必须小于 NAT 超时
```

**"连接看着 ESTABLISHED 但发不出数据"** → 大概率是 NAT/中间设备已经把会话丢了。

### 关键内核参数（按场景）

```conf
# 高并发短连接
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1

# 保活（穿透 NAT）
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 3

# 重传与超时
net.ipv4.tcp_syn_retries = 3
net.ipv4.tcp_retries2 = 8
```

**"端口不够用"** → 扩 ip_local_port_range（并考虑长连接）。

### 一个"看状态定位"的流程

```
1) ss -s → 哪类状态数量异常
2) 对应状态 → 查原因（见上表）
3) ss -ti → 看 rtt/retrans/cwnd
4) 抓包 → 确认握手与重传
```

**"先看状态分布"** 比直接抓包快。

### 检查清单

```
□ 会读 ss 的 state 过滤
□ 知道 CLOSE_WAIT = 应用没关
□ 知道 TIME_WAIT 多为正常现象
□ 会用 ss -ti 看重传/窗口
□ backlog/somaxconn 已调
□ keepalive < NAT 超时
□ 不用 tcp_tw_recycle
□ 长连接优先于调参数
□ 中间设备会话表有监控
□ 有"状态分布"看板
```
