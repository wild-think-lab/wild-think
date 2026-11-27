---
title: Wireshark / tcpdump 速查
summary: 抓包过滤器两层、常用显示过滤、TCP 问题定位与三个"抓到但看不懂"的典型现象。
group: network
order: 4
tags: [tcpdump, Wireshark, 抓包]
---

### 两层过滤器（最容易搞混的地方）

```
抓包过滤器（BPF）：tcpdump -f / Wireshark 抓包前设置 → 决定"抓什么"
显示过滤器（Display）：Wireshark 抓完后筛选 → 决定"看什么"
```

**先抓对了，才谈得上看得懂**。

### tcpdump 常用

```bash
# 指定网卡、主机、端口
tcpdump -i eth0 host 10.0.0.5
tcpdump -i eth0 port 80
tcpdump -i any port 443 -n

# 保存（供 Wireshark 分析）
tcpdump -i eth0 -s 0 -w cap.pcap port 8080

# 限制数量与滚动（生产环境必备）
tcpdump -i eth0 -C 100 -W 5 -w cap.pcap port 8080   # 每个 100MB，共 5 个

# 只看 SYN/FIN（握手与关闭）
tcpdump -i eth0 'tcp[tcpflags] & (tcp-syn|tcp-fin) != 0'

# 看 HTTP 请求行
tcpdump -i eth0 -A -s 0 'tcp port 80' | grep -E "GET|POST|Host"

# 排除本机
tcpdump -i eth0 not host 127.0.0.1
```

**`-s 0`** 是抓完整包（默认在老版本里会截断），**必须加**。

### BPF 语法

```bash
host 1.2.3.4            # 主机
src host 1.2.3.4        # 源
dst port 443            # 目的端口
portrange 8000-9000     # 端口段
net 10.0.0.0/24         # 网段
tcp / udp / icmp        # 协议
and / or / not          # 组合
```

**例子**：

```bash
tcpdump -i eth0 'tcp and dst port 3306 and not src net 10.0.0.0/8'
```

### Wireshark 显示过滤器

```
ip.addr == 10.0.0.5
tcp.port == 8080
http.request.method == "POST"
http.response.code >= 500
dns.qry.name contains "example"
tls.handshake.type == 1        # ClientHello
tcp.analysis.retransmission    # 重传
tcp.analysis.zero_window       # 零窗口
tcp.flags.syn == 1 and tcp.flags.ack == 0   # 纯 SYN
```

**最有用的几个**：

```
tcp.analysis.flags            # 所有异常标记（重传/乱序/丢包）
tcp.stream eq 3               # 只看第 3 个 TCP 流
follow tcp stream             # 右键 → 跟踪流
```

### TCP 三次握手与四次挥手（对着包看一遍）

```
握手：SYN → SYN,ACK → ACK
挥手：FIN → ACK → FIN → ACK
```

**Wireshark 里怎么看**：

```
① 过滤 tcp.flags.syn==1 看谁主动发 SYN（判断谁在连谁）
② 看 SYN 有没有 SYN,ACK 回来（没回来 = 对端没开/被墙）
③ 看 RST（有 RST = 被拒绝或连接被 reset）
```

**"连不上"的三种包级表现**：

```
只有 SYN，没有响应 → 防火墙丢包 / 服务没监听
SYN → RST         → 端口没开 / 服务拒绝
SYN → ICMP unreachable → 路由不可达
```

### 三个"抓到但看不懂"的典型现象

**① 大量重传（retransmission）**

```
含义：同一段数据被发了多次
原因：丢包（网络）或对端没回 ACK（对端慢）
判别：看 ACK 是否延迟（tcp.analysis.ack_lost_segment）
```

**快速统计重传率**：

```bash
tshark -r cap.pcap -Y "tcp.analysis.retransmission" | wc -l
tshark -r cap.pcap -Y "tcp" | wc -l
```

**② 零窗口（zero window）**

```
含义：接收方缓冲区满了，通告窗口 0
原因：应用层读得慢（不是网络问题）
→ 这是"抓包指向应用，而非网络"的关键证据
```

**③ 乱序（out-of-order）**

```
含义：序号不连续
原因：多路径转发 / 负载均衡不同链路 → 常见且通常无害
判别：如果只是乱序、最终都到了，重传不增加
```

### HTTP/2 与 TLS 的抓包限制

```
HTTPS 默认看不到内容（要解密）
① 浏览器可导出 SSLKEYLOGFILE 给 Wireshark 解密
② 服务端可提供私钥（RSA 密钥交换才可行，ECDHE 不行）
③ HTTP/2 是二进制帧，要 Wireshark 才能解析（tcpdump 看不清）
```

**导出密钥（浏览器）**：

```bash
export SSLKEYLOGFILE=/tmp/sslkey.log
# 然后在 Wireshark: Preferences → Protocols → TLS → (Pre)-Master-Secret log
```

**HTTP/2 分析**：

```
过滤器：http2
看 streams、HEADERS 帧、RST_STREAM（对端取消）
```

### 性能问题定位路径

```
① 延迟高 → 看 TCP 握手耗时 + 首字节时间
② 吞吐低 → 看窗口大小（window size）与丢包
③ 连接多 → 看 TIME_WAIT 数量与端口耗尽
④ 偶发失败 → 看重传/RST 的时间点与目标
```

**"握手耗时"怎么算**：

```
在 Wireshark 里看 SYN 与 SYN,ACK 的时间差
→ 等于一次 RTT
```

### 一个实战流程

```bash
# 1. 在服务端抓（先粗后细）
tcpdump -i any -n -s 0 -w /tmp/cap.pcap host 10.0.0.5 and port 8080

# 2. 复现问题（保持抓包 20–60 秒）

# 3. 停止抓包，拉回本地用 Wireshark 打开

# 4. 先用 tcp.analysis.flags 找到异常包

# 5. 右键 → Follow TCP Stream 看完整对话

# 6. 对照时间线，确定是谁的问题
```

### 坑

```
① 生产抓包会占 CPU/磁盘 → 一定加 -C/-W 限制
② 容器里抓要进网络命名空间（nsenter 或 --net=container）
③ 抓 any 会看到重复包（进出各一次）
④ 抓不到包 → 检查网卡名、是否在正确 netns、是否有 eBPF 拦
⑤ 上传大 pcap 到 Wireshark 会卡（用 editcap 切片）
```
