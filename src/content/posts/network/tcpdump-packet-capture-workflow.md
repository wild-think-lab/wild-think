---
title: 抓包这件事：从"能 ping 通但服务连不上"到定位结论
description: 抓包不是打开 Wireshark 慢慢翻。先明确要验证的假设，再用最小过滤器取证——丢包、RST、重传、握手卡点各有各的抓法。
date: 2026-11-25
tags: [网络, 抓包, tcpdump, 排障]
---

"能 ping 通但服务连不上"这句话本身就包含了一组矛盾假设。抓包的价值不是看流量热闹，而是**把假设逐一排除**。

## 一、先想清楚要证明什么

每类现象对应的取证目标不同：

| 现象 | 要验证的假设 | 抓什么 |
| --- | --- | --- |
| 连不上、无响应 | 包到了没回 / 根本没到 | 客户端出向 + 服务端入向 |
| 连得上但立刻断 | 谁发的 RST | `tcpdump -i any 'tcp[tcpflags] & tcp-rst != 0'` |
| 时快时慢 | 是否重传、是否丢包 | 重传计数 + `ss -ti` |
| 只有部分客户端异常 | MTU / 分片问题 | 大包是否被丢、DF 标志 |
| TLS 握手失败 | 卡在哪个阶段 | 握手报文序列 |

先写结论句式："如果我能看到服务端返回 SYN-ACK，说明路径通、端口在听"。抓完再回头对照。

## 二、tcpdump 的三种最小抓法

```bash
# 1. 单个连接的全过程（客户端视角）
sudo tcpdump -i any -nn -tttt 'host 10.0.0.5 and port 3306' -c 40

# 2. 只看握手与拆链，避免日志被数据淹没
sudo tcpdump -i eth0 -nn 'host 10.0.0.5 and tcp[tcpflags] & (tcp-syn|tcp-fin|tcp-rst) != 0'

# 3. 落盘分析（-s 0 抓完整包，别让 snaplen 截断载荷）
sudo tcpdump -i eth0 -nn -s 0 -w /tmp/cap.pcap 'port 443'
```

三个容易踩的点：

- **`-i any` 会丢失方向语义**，且部分内核下链路层头不同。定位单向问题要按设备分别抓：`-i eth0` 与 `-i eth1`。
- **容器/命名空间要走宿主机对应 veth**：`ip -br a` 找到容器 veth 名，再 `tcpdump -i vethXXXX`；或 `nsenter -t <pid> -n tcpdump ...` 进容器网络命名空间。
- **`-tttt` 加绝对时间**，否则时间戳对不上其他日志，事后拼不出因果。

## 三、按现象读包

### 只有 SYN，没有 SYN-ACK

```text
14:22:01.001  10.0.0.5:41234 > 10.0.0.9:3306  S
14:22:02.003  10.0.0.5:41234 > 10.0.0.9:3306  S   (重传 1)
14:22:04.007  10.0.0.5:41234 > 10.0.0.9:3306  S   (重传 2)
```

三种解释，按概率排序：

1. **服务端没在听**（无进程监听该端口）——正常内核会回 RST，但防火墙 DROP 时表现为静默。所以先看服务端 `ss -lntp | grep 3306`。
2. **中间设备 DROP**（安全组、iptables、云厂商 ACL）。判断依据：两端同时抓，服务端看不到 SYN。
3. **回程路由缺失**：服务端能看到 SYN 并回了 SYN-ACK，但 SYN-ACK 到不了客户端。这种最容易被误判成"服务没启动"。

### 服务端回 RST

```text
10.0.0.9:3306 > 10.0.0.5:41234  S.   →  10.0.0.9:3306 > 10.0.0.5:41234  R
```

- `S.` 后紧跟 `R` 且序号正常：端口没有监听者（内核立即拒绝）。
- 握手完成后数据阶段被 RST：应用主动断开或连接队列溢出（`netstat -s | grep -i overflow`）。
- 客户端发 RST：常见于本地端口被复用或应用提前退出。

### 半开连接与重传

`ss -ti` 比抓包更快看到全貌：

```bash
ss -ti state established '( dport = :443 )' | head -20
# 关注 retrans、rtt、cwnd、unacked
```

`retrans` 持续增长说明有丢包；`unacked` 堆积而 `cwnd` 很小，说明拥塞控制已经把窗口压到底——此时抓包只会看到重复的旧数据段，问题在链路。

### MTU 与分片

现象：小请求正常，大响应超时。因为报文带 DF 位且超过路径 MTU，中间设备丢弃但**不回 ICMP**（很多云环境禁 ICMP）。

```bash
ping -M do -s 1472 10.0.0.9     # 1472+28=1500，成功说明路径 MTU ≥1500
ping -M do -s 1400 10.0.0.9     # 逐步二分，找到真实 PMTU
```

修复方式优先级：统一 MTU / 开 PMTUD（保证 ICMP 不被全禁）→ 调 MSS（`iptables -t mangle -A ... --clamp-mss-to-pmtu`）→ 应用层减小包体。

## 四、TLS 握手阶段定位

```bash
# 不用抓包也能看阶段，但抓包能证明"卡在哪一步"
openssl s_client -connect api.example.com:443 -servername api.example.com -showcerts </dev/null
curl -v --max-time 10 https://api.example.com/health
```

抓包里看 ClientHello 之后是否收到 ServerHello：

- 有 ClientHello、无 ServerHello → 服务端 SNI 未匹配、证书配置错误、或 443 被拦。
- ServerHello 后卡住 → 证书链校验慢（OCSP 阻塞）或密钥交换失败。
- 握手完成后立即 FIN/RST → 应用层拒绝（如 mTLS 客户端证书无效）。

`openssl s_client` 的 `-servername` 必须显式给，否则默认不发 SNI，多域名服务器会返回默认证书，让人误判"证书不对"。

## 五、抓包工具的分工

| 工具 | 适合 | 不适合 |
| --- | --- | --- |
| tcpdump | 服务器侧取证、脚本化、长时间低开销 | 交互式分析 |
| Wireshark | 协议解码、重组、TLS 解密（有密钥） | 生产机器上跑 GUI |
| ss / netstat | 连接状态、队列、重传统计 | 报文内容 |
| curl -v / `--trace-time` | HTTP 层时序、代理、重定向 | 四层以下 |
| mitmproxy / Charles | HTTP(S) 调试、改包、移动端抓包 | 无法解密的应用（证书固定） |

抓包文件统一落盘再分析：`tcpdump -w` → 拷回本地 → Wireshark 开 `tcp.stream eq N`，比在服务器上 `-X` 打十六进制高效得多。

> 一句经验：**两端同时抓包、只抓关键标志位、先写假设再抓**。只在一端抓，永远分不清"没发出"和"没收到"——而这正是九成纠纷的根源。
