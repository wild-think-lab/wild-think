---
title: 抓包：用证据代替猜测
module: 入门篇
summary: tcpdump 的十个过滤器、三次握手与重传怎么看、Wireshark 的三个实用视图，以及"抓不到包"的原因。
minutes: 30
---

### 抓包解决的是"猜"的问题

```
"服务端说没收到请求" vs "客户端说发了"
→ 只有一个办法能定论：看包
```

### tcpdump 十个过滤器

```bash
tcpdump -i eth0 -nn                       # 全部（慎用，量巨大）
tcpdump -i eth0 -nn port 443              # 按端口
tcpdump -i eth0 -nn host 10.0.0.5         # 按主机
tcpdump -i eth0 -nn 'src 10.0.0.5'        # 源
tcpdump -i eth0 -nn 'tcp[tcpflags] & tcp-syn != 0'   # 只看 SYN
tcpdump -i eth0 -nn 'tcp[tcpflags] & tcp-rst != 0'   # 只看 RST
tcpdump -i any -nn port 53                # 所有接口（含 lo）
tcpdump -i eth0 -nn -s 0 -w out.pcap      # 存文件（-s 0 抓全包）
tcpdump -i eth0 -nn -A port 80            # 打印 payload
tcpdump -i eth0 -nn 'greater 1000'        # 按包长
```

**`-s 0`** 至关重要（默认只抓前 96 字节，抓不到 payload）。

### 三次握手怎么看

```
客户端 → 服务端：SYN
服务端 → 客户端：SYN,ACK
客户端 → 服务端：ACK
```

**四种异常**：

```
① 只有 SYN，没有 SYN,ACK → 服务端没收到/没监听/被丢
② SYN 后回 RST → 端口没监听 或 防火墙 REJECT
③ 三次握手完成后立刻 RST → 应用层拒绝（如 TLS 失败）
④ 反复重传 SYN → 网络丢包/中间设备丢
```

**"SYN 重传但对方无响应"** → 通常是"没到"（路由/防火墙 DROP）。

### 重传与乱序

```bash
tcpdump -i eth0 -nn 'tcp[tcpflags] & tcp-ack != 0' -w retrans.pcap
# 或在 Wireshark 里看 "TCP Retransmission" / "Fast Retransmission"
```

**重传率高说明**：

```
① 链路丢包
② 带宽被打满（队列丢弃）
③ 中间设备限速
```

**"延迟大但没重传"** → 更像"应用/服务端处理慢"，不是网络丢包。

### Wireshark 三个实用视图

```
① Statistics → Flow Graph（时序图，一眼看谁先谁后）
② Statistics → TCP Stream Graphs → Round Trip Time（RTT 曲线）
③ Follow → TCP Stream（看完整会话内容）
```

**"Flow Graph"** 是最直观的"谁卡住了"视图。

### 五个"抓不到包"的原因

**① 抓错接口**

```
容器/多网卡/绑定 → 用 `-i any` 先确认
```

**② 流量不经本机**

```
中间有 LB/网关 → 要抓"真正转发的那一跳"
```

**③ 被内核卸载（offload）**

```
某些网卡把包交给硬件处理 → tcpdump 看不到
→ 临时关闭 `ethtool -K eth0 gro off lro off`
```

**④ 权限不足**

```
需要 CAP_NET_RAW（root 或 setcap）
```

**⑤ 包太大被丢**

```
抓包缓冲区不足 → 用 `-B 4096` 加大
```

### 一个"排障"用法示例

**现象**：客户端偶发 502。

```
1) 在 nginx 抓包：tcpdump -i any -nn 'port 8080' -w up.pcap
2) 在 Wireshark 看 Flow Graph：
   发现 nginx 发 SYN 后没有 SYN,ACK
3) 结论：后端端口没监听/被防火墙丢
4) 去后端 ss -lntp → 确认进程刚重启还没起
```

**"偶发"也能被抓住**，因为证据是具体的。

### 小结

```
① 抓包是唯一能"定论"的手段
② -s 0 不要忘
③ 先看握手异常（SYN/RST/重传）
④ Flow Graph 最直观
⑤ 抓不到先查接口与 offload
```
