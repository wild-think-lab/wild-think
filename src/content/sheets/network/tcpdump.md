---
title: tcpdump 抓包速查
summary: 五个必备参数、常用过滤表达式、按方向抓、存盘与读盘、以及"抓了但看不出问题"的三个原因。
group: 网络
order: 5
tags: [tcpdump, 网络, 排障]
---

### 五个必备参数

```bash
tcpdump -i eth0 -nn -s0 -c 100 -w out.pcap
```

| 参数 | 作用 |
| --- | --- |
| `-i eth0` | 指定网卡（`any` 表示所有） |
| `-nn` | 不做 DNS/端口名解析（快，且不产生额外流量） |
| `-s0` | 抓完整包（默认可能截断） |
| `-c 100` | 抓 100 个就停（防止文件爆炸） |
| `-w out.pcap` | 写文件而不是打印 |

读包：

```bash
tcpdump -nn -r out.pcap | head -20
tcpdump -nn -r out.pcap 'tcp port 8080'
```

### 常用过滤

```bash
# 按主机
tcpdump -nn host 10.0.0.5
tcpdump -nn src 10.0.0.5
tcpdump -nn dst 10.0.0.5

# 按端口
tcpdump -nn port 8080
tcpdump -nn src port 443

# 按网络
tcpdump -nn net 10.0.0.0/24
tcpdump -nn 'not net 10.0.0.0/24'

# 组合
tcpdump -nn 'host 10.0.0.5 and tcp port 8080'

# 只看 SYN（判断有没有连上来）
tcpdump -nn 'tcp[tcpflags] & tcp-syn != 0'

# 只看 RST（判断是否被拒绝）
tcpdump -nn 'tcp[tcpflags] & tcp-rst != 0'

# HTTP 请求行（需要未加密）
tcpdump -nn -A -s0 'tcp port 80 and tcp[((tcp[12]&0xf0)>>2):4] = 0x47455420'

# ICMP（丢包/MTU 问题）
tcpdump -nn icmp
tcpdump -nn icmp6
```

### 常用场景

```bash
# ① 服务"连不上"：抓 SYN 与 RST
tcpdump -nn -i eth0 'host 10.0.0.9 and tcp port 8080'

# ② 丢包：看有没有重传
tcpdump -nn -i eth0 'tcp port 8080' | grep -c retrans

# ③ DNS 解析慢
tcpdump -nn udp port 53

# ④ MTU 问题（ICMP frag needed）
tcpdump -nn 'icmp and icmp[icmptype] == 3'

# ⑤ 大量抓包后分析（用 wireshark/tshark）
tshark -r out.pcap -Y 'http.request' -T fields -e http.host -e http.request.uri | head
```

### 判断口诀

| 抓到什么 | 说明 |
| --- | --- |
| SYN 有，SYN-ACK 无 | 服务没监听 / 防火墙 DROP |
| SYN 有，RST 回 | 端口关闭或明确拒绝 |
| SYN 重传多次 | 对端不可达或被丢 |
| 数据包有 retrans | 链路质量差或拥塞 |
| 只有单向流量 | 路由/回程问题 |
| `Frag needed` | MTU 不匹配 |

### 三个"抓了但看不出问题"的原因

1. **抓错网卡**：容器/虚拟机流量在 `veth`/`br0` 上，不在 `eth0`。
2. **被加密**：HTTPS/QUIC 看不到内容，只能看握手与流量大小。
3. **抓的位置不对**：在客户端抓只能证明"发出去了"，证明不了"对端收到了"——要两端同时抓。

### 权限与性能

```bash
# 需要 root 或 CAP_NET_RAW
sudo tcpdump ...

# 高流量下加缓冲，避免丢包
tcpdump -i eth0 -nn -B 4096 -w out.pcap
```

`-B` 设置缓冲区（KB），流量大时不加会因内核缓冲满而丢包——**抓包工具自己丢包，会让你误判**。

生产上抓包要限时：

```bash
timeout 30 tcpdump -i eth0 -nn -s0 -w /tmp/cap.pcap 'port 8080'
```
