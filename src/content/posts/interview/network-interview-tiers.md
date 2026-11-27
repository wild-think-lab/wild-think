---
title: 网络方向面试题：从三次握手问到丢包定位
description: 网络题最容易答成背书。把每条结论挂到"能验证的现象"上，面试官就知道你真抓过包。
date: 2025-12-08
tags: [面试, 网络, TCP/IP, 排障, 抓包]
---

网络面试的高分答案有个共同特征：**每个结论后面跟着一个可验证的现象或命令**。

## 一、TCP 建立与释放

### Q：为什么是三次握手，不是两次？

**结论**：两次无法让双方都确认"对方收到了我的初始序列号且我也收到了对方的"，也无法防止历史重复连接。

**原理**：第三次握手让服务端确认自己的 SYN+ACK 被收到，同时客户端借此确认服务端已就绪。序列号同步是可靠传输的前提。

**追问**：SYN 洪水攻击怎么防？——`net.ipv4.tcp_syncookies=1` 开启后，SYN 队列满时用加密 cookie 回复，不占半连接队列；同时确认 `tcp_max_syn_backlog` 与 `somaxconn` 是否合理。

### Q：四次挥手为什么不能三次？

**结论**：TCP 是全双工，两个方向要各自独立关闭。收到 FIN 只说明对方没有数据要发了，我方可能还有数据要发，所以 ACK 与 FIN 不能合并。

**追问**：为什么有 TIME_WAIT，等多久？——2MSL（Linux 实现 60s），保证最后 ACK 可重传、旧报文不在新连接中出现。

### Q：服务端出现大量 CLOSE_WAIT 说明什么？

**结论**：**应用层没有调用 `close()`**。这是代码问题，不是网络问题。

**原理**：收到对方 FIN 后内核自动回 ACK 并进入 CLOSE_WAIT，等待应用关闭；应用不关就一直挂着，句柄泄漏直到耗尽。

```bash
ss -tan state close-wait | head
lsof -p <pid> | wc -l      # 看句柄数量是否异常增长
```

## 二、连接与端口

### Q：一台服务器能支撑多少并发连接？

**结论**：理论上受四元组数量限制（本地端口约 28k 个到同一目的），实际受 `ulimit -n`、内存（每连接 socket 缓冲）、应用架构限制。

**原理**：`fs.file-max`、`nofile` 是硬门槛；`tcp_mem` 控制内核 TCP 内存。作为服务端时，四元组的"本地端口"是服务端口固定，因此限制来自客户端 IP×端口组合，可达数百万。

**追问**：怎么突破单机上限？——多进程/多 IP（`SO_REUSEPORT` + 多 listen）、连接复用（HTTP/2、长连接）、水平扩展。

### Q：`curl` 很慢但 `ping` 正常，可能是什么？

**结论**：分层剥离。ping 只证明 ICMP 可达，TCP 建连与 TLS 握手可能才是瓶颈。

```bash
curl -w 'dns:%{time_namelookup} conn:%{time_connect} tls:%{time_appconnect} ttfb:%{time_starttransfer} total:%{time_total}\n' -o /dev/null -s https://example.com
```

- `time_namelookup` 大 → DNS 解析慢（换 DNS、查 `/etc/resolv.conf` 的 `options timeout`）
- `time_connect` 大 → 建连慢（路由、防火墙、SYN 重传）
- `time_appconnect` 与 `time_connect` 差大 → TLS 握手慢（证书链、会话复用、加密套件）
- `time_starttransfer - time_appconnect` 大 → 服务端处理慢

## 三、丢包与延迟

### Q：怎么定位丢包发生在哪一跳？

**结论**：`mtr` 双向对比，注意 ICMP 限速会造成"假丢包"。

```bash
mtr -n -c 100 target            # 逐跳丢包率
# 反向也在目标机跑一遍，确认是单向还是双向
```

判据：**只有某一跳 100% 丢包但后续跳正常 → 该设备不响应 ICMP，不是真丢包**；若某跳开始持续丢包且后续跳都丢 → 该链路真实丢包。

**追问**：TCP 丢包怎么确认？——`ss -ti` 看 `retrans`、`lost`；`netstat -s | grep -i retrans` 看全局重传率；抓包里出现重复 ACK 与快速重传即证实。

### Q：为什么带宽够但传输很慢？

**结论**：常见三因——**窗口太小（BDP 受限）、丢包导致拥塞窗口反复收缩、单流被限速**。

**原理**：吞吐 ≈ 窗口/RTT。长肥管道（高 RTT）必须开大窗口（`tcp_rmem/wmem` + 窗口缩放），否则带宽用不满。

```bash
ss -ti | grep -E 'cwnd|rtt'
sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem net.ipv4.tcp_window_scaling
```

## 四、DNS 与 HTTP

### Q：DNS 解析慢/失败怎么排查？

**结论**：按"本地缓存 → 递归服务器 → 权威服务器"三段查。

```bash
dig +trace example.com         # 从根开始走一遍
dig @8.8.8.8 example.com +short
cat /etc/resolv.conf           # 注意 options timeout:1 attempts:2
```

容器里要注意 `/etc/resolv.conf` 被 Docker 改写为 `127.0.0.11`，宿主机 DNS 故障会放大成"所有服务变慢"。

### Q：HTTP/1.1、HTTP/2、HTTP/3 的核心差异？

| 版本 | 连接 | 并发 | 队头阻塞 |
| --- | --- | --- | --- |
| 1.1 | 每域 6 条 TCP | 靠多连接 | 有（同连接内串行） |
| 2 | 单 TCP 多路复用 | 流并发 | TCP 层仍有（丢包阻塞所有流） |
| 3 | QUIC over UDP | 流并发 | 基本消除（流级独立） |

**追问**：为什么 HTTP/2 在丢包高的时候可能比 1.1 还慢？——单连接多路复用把鸡蛋放一个篮子，TCP 丢包会阻塞全部流。

## 五、答题套路

1. 先给判断（"这是 CLOSE_WAIT 堆积，属于应用没关连接"）
2. 说机制（内核状态机怎么走）
3. 给验证命令（`ss` / `mtr` / `curl -w` / `tcpdump`）
4. 说边界（ICMP 限速、NAT 改写、容器网络差异）

> 网络题最忌讳"概念正确但没有现象支撑"。能说出"用哪条命令看到什么"，就已经超过大多数候选人。
