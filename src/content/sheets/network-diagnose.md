---
title: 网络排障命令速查
summary: 网络不通怎么查：从链路、IP、路由、DNS、端口到抓包，按层往下走的一套固定手势，配最常用的参数。
group: 网络
order: 3
tags: [网络, 排障, tcpdump, DNS]
---

## 先按层走一遍，别乱猜

```
L1 网线/光模块 → ip link（有没有 UP，有没有 CRC 错误）
L2 ARP/MAC     → ip neigh
L3 IP/路由     → ip addr、ip route、traceroute
L4 端口        → ss -lntp、telnet/nc
L7 应用/DNS    → dig、curl -v
```

## 接口与地址

```bash
ip -br link                 # 一眼看所有网卡与状态
ip -br addr                 # 简洁版地址表
ip -s link show eth0        # 收发包、错误、丢包计数
ethtool eth0                # 速率、双工、链路状态
ethtool -S eth0 | grep -i err
```

`errors` / `dropped` 持续增长，先查物理层与交换机端口，不要在应用层浪费时间。

## 路由

```bash
ip route
ip route get 8.8.8.8        # 走哪条路由、从哪个源出去（最好用的一条）
ip neigh                    # ARP 表；不完整说明二层不通
traceroute -n 8.8.8.8
mtr -n -c 20 8.8.8.8       # 结合 ping + traceroute，看丢包发生在哪一跳
```

`ip route get` 是排查"多网卡走错出口"的第一条命令。

## 端口与连接

```bash
ss -lntp                          # 监听中的 TCP，带进程
ss -tnp state established         # 已建立连接
ss -s                             # 连接数汇总（TIME_WAIT 多不多）
ss -tnp dst :443 | wc -l
ss -tn state time-wait | awk '{print $4}' | cut -d: -f2 | sort | uniq -c | sort -rn | head
```

```bash
nc -vz host 443            # 端口通不通
nc -u -vz host 53          # UDP
timeout 3 bash -c '</dev/tcp/host/443' && echo open
curl -v --connect-timeout 3 https://host/
```

TIME_WAIT 大量堆积通常是短连接太多，考虑连接池或 `net.ipv4.tcp_tw_reuse`（谨慎）。

## DNS

```bash
dig +short example.com
dig @223.5.5.5 example.com A +norecurse
dig -x 10.0.0.5                       # 反解
dig example.com ANY +noall +answer
dig +trace example.com                # 从根开始看委派链
nslookup -type=SRV _ldap._tcp.corp.local
```

常见"网页打不开但 IP 能通"：DNS 解析错、解析到 IPv6 但本地无 IPv6、`/etc/resolv.conf` 被 NetworkManager 覆盖。查 `/etc/nsswitch.conf` 的 `hosts:` 顺序也很重要（有的人写了 `files mdns4_minimal` 导致解析慢）。

## 抓包

```bash
tcpdump -i any -nn -c 50 'host 10.0.0.5 and port 8080'
tcpdump -i eth0 -nn -s0 -w /tmp/x.pcap 'tcp port 443'
tcpdump -i any -nn -A 'port 3306' | head -100     # 看明文内容（仅内网调试）
tcpdump -i any -nn 'tcp[tcpflags] & (tcp-syn|tcp-rst) != 0'   # 只看建连/重置
```

读 pcap 用 Wireshark 或 `tshark`：

```bash
tshark -r x.pcap -Y 'http.request' -T fields -e http.host -e http.request.uri
tshark -r x.pcap -q -z conv,tcp        # 会话统计
```

**抓到 RST 说明对端明确拒绝**（端口没开或有防火墙 reject）；**只有 SYN 无回应**通常是 drop（防火墙 DROP 或路由不通）。

## 防火墙

```bash
iptables -S                     # 规则全貌
iptables -L -n -v --line-numbers
iptables -t nat -L -n -v
nft list ruleset                # nftables 环境
firewall-cmd --list-all
```

`iptables -S` 比 `-L` 更适合贴给同事看，能直接复现规则。

## 带宽与延迟

```bash
iperf3 -s                       # 服务端
iperf3 -c 10.0.0.5 -t 10 -P 4   # 4 并发流
ping -c 100 -i 0.2 host | tail -3
curl -o /dev/null -s -w 'dns:%{time_namelookup} tcp:%{time_connect} tls:%{time_appconnect} ttfb:%{time_starttransfer} total:%{time_total}\n' https://host/
```

`curl -w` 那段是定位"慢在哪一段"的最快办法：DNS 慢 ≠ TCP 慢 ≠ 后端慢。
