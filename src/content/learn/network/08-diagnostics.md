---
title: 诊断工具全家桶：一条"不通"的完整取证
module: 熟练篇
summary: ping/mtr/telnet/curl/dig/tcpdump 的分工、每一层该用哪个、以及五个"用错工具得出的错结论"。
minutes: 45
---

### 分层工具表

| 层 | 工具 | 回答什么 |
| --- | --- | --- |
| 链路/IP | `ping` | 能不能到（ICMP） |
| 路径 | `mtr` | 哪一跳开始丢 |
| 端口 | `nc -zv` / `telnet` | 端口开不开 |
| 应用 | `curl -v` | HTTP 层发生了什么 |
| 名称 | `dig` / `getent` | 域名解析对不对 |
| 抓包 | `tcpdump` | 包到底到没到 |
| 连接 | `ss` | 本机有没有建立/监听 |

**"ping 不通就说网络挂了"** 是最常见的错误结论（ICMP 常被禁）。

### ping / mtr

```bash
ping -c 4 10.0.0.1
mtr -rw -c 10 example.com
```

**判据**：

```
mtr 中间跳丢包但最后一跳正常 → 中间设备限速 ICMP（正常）
最后一跳也丢 → 真有问题
```

### 端口

```bash
nc -zv -w3 10.0.0.1 3306
```

**"telnet 连上但没响应"** → 端口通，应用层不回（不是网络问题）。

### curl

```bash
curl -v --max-time 5 https://example.com
curl -o /dev/null -s -w '%{http_code} %{time_total}\n' https://example.com
```

**看四段耗时**：

```
time_namelookup    DNS
time_connect       TCP
time_appconnect    TLS
time_starttransfer 首字节
```

**"慢在哪一段"** 一目了然。

### dig

```bash
dig +short example.com
dig @8.8.8.8 example.com
dig +trace example.com
```

**"能 ping 通 IP 但域名不行"** → DNS 问题，不是网络。

### tcpdump（最后的手段，也是最硬的证据）

```bash
tcpdump -i any -nn host 10.0.0.1 and port 3306 -c 20
tcpdump -i eth0 -nn 'tcp[tcpflags] & tcp-syn != 0'
```

**判据**：

```
只看到 SYN 没有 SYN-ACK → 对端没回（防火墙/没监听）
看到 SYN-ACK 但客户端 RST → 客户端不认（连接被中断）
看到 RST → 立即被拒（端口关闭/被安全设备阻断）
```

### 五个"用错工具得出的错结论"

**① 用 ping 判断"服务是否可用"**

```
ICMP 通 ≠ 端口通
```

**② 用 telnet 判断"应用是否正常"**

```
TCP 通 ≠ HTTP 正常（可能 500）
```

**③ 在容器里 curl 失败就怪网络**

```
容器 DNS/网络命名空间与宿主不同
```

**④ 只看一次 mtr**

```
瞬时抖动 ≠ 持续问题（要多次采样）
```

**⑤ 抓包位置错**

```
在客户端抓不到"服务端收到没"（要两端对照）
```

### 一条完整取证流程

```
1) getent hosts 域名        # 名称
2) nc -zv host port         # 端口
3) curl -v（看四段耗时）    # 应用
4) mtr -rw（看路径）        # 路径
5) tcpdump（两端对照）      # 证据
```

### 检查清单

```
□ 知道每层该用什么工具
□ 不拿 ping 当"服务可用"的证据
□ 会用 curl 的耗时分解
□ 会用 mtr 判"哪一跳"
□ 会两端抓包对照
□ 知道容器网络与宿主不同
□ 有"连通性自检脚本"
```
