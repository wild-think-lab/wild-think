---
title: 网络层排错：从 ping 到抓包
module: 入门篇
summary: 五条命令的排查链、DNS/端口/路由/TLS 四类常见断裂点，以及什么时候该抓包、抓到之后看什么。
minutes: 26
---

### 排查链：从近到远

```bash
# 1. 本机地址与路由
ip addr
ip route

# 2. 通不通（别只用 ping）
ping -c 3 <ip>
nc -vz -w 3 <ip> <port>

# 3. DNS
dig +short <domain>
dig @<dns-server> <domain>

# 4. 路径
mtr -T -p <port> <ip>

# 5. 端口与连接
ss -lntp              # 本机监听
ss -tnp | head       # 本机连接
```

**关键提醒：`ping` 通不代表服务可用**。很多环境禁 ICMP，而端口是通的。

### 四类断裂点

**① DNS**

```bash
dig +short api.example.com        # 解析结果
dig @8.8.8.8 api.example.com      # 换 DNS 对比
dig +trace api.example.com        # 逐级看哪一级慢/失败
cat /etc/resolv.conf              # 本机配置
```

**常见问题**：

```
- resolv.conf 指向了不存在的 DNS（容器里尤其常见）
- search domain 导致多次查询（app.example.com → app.example.com.svc.cluster.local）
- JVM 的 DNS 缓存默认永不失效（改了记录但不生效）
```

**② 端口不通**

```bash
nc -vz -w 3 host 443
telnet host 443
```

**判断分层**：

```
本机 nc 不通          → 服务没监听（查 ss -lntp）
本机通，同网段不通     → 防火墙（iptables/firewalld/安全组）
同网段通，公网不通     → 云安全组 / 运营商 / LB
```

**③ 路由/路径**

```bash
mtr -T -p 443 -n target
traceroute -T -p 443 target
```

**`mtr` 比 traceroute 好在**：它是持续的，能看到丢包率，而不是单次采样。

**判读**：

```
某一跳开始持续丢包 → 那个位置有问题
中间跳偶尔丢包但后续正常 → 路由器对 ICMP 限速（不是真故障）
```

**④ TLS**

```bash
openssl s_client -connect host:443 -servername host </dev/null 2>/dev/null | openssl x509 -noout -dates -subject
curl -vI https://host/
```

**常见错误**：

```
certificate has expired
certificate is not valid for this domain（SNI 没传对）
unable to get local issuer certificate（客户端缺中间证书）
```

**中间证书缺失是最常见的**：浏览器能打开（会自动补链），但 Java/Python 客户端报错。

### 什么时候该抓包

```
① 现象无法用日志解释（如"请求发出去了但没到应用"）
② 怀疑丢包/重传
③ 需要证明"不是我们的问题"
④ TLS 握手失败
```

**开始抓包的最小命令**：

```bash
# 抓某主机某端口
tcpdump -i any -nn host 10.0.0.5 and port 443 -c 100 -w /tmp/x.pcap

# 实时看
tcpdump -i eth0 -nn 'tcp port 8080' -A -s 0 | head -100
```

**关键参数**：

```
-i any      所有网卡（容器/多网卡必备）
-nn         不做反解（更快、更准）
-c 100      抓 100 个包就停（防文件爆炸）
-s 0        抓完整包（默认会截断）
-w file     写文件（用 Wireshark 分析）
-A          以 ASCII 显示内容（看 HTTP 明文）
```

### 抓到之后看什么

**四个必看**：

```
① 三次握手有没有完成（SYN → SYN/ACK → ACK）
   - 只有 SYN 没有 SYN/ACK → 对端没监听或被挡
   - SYN 重传 3 次 → 丢包/防火墙丢

② 有没有 RST
   - RST 立刻返回 → 端口没开或被拒绝
   - 中间 RST → 有设备在重置连接（WAF/防火墙）

③ 有没有重传（retransmission）
   - 少量重传正常，大量重传 = 链路质量差

④ 窗口大小
   - rwnd = 0 → 接收方处理不过来（应用慢）
```

**在 Wireshark 里看**：

```
Analyze → Expert Information
会直接列出"重传""乱序""零窗口"等问题
```

### 一个"访问慢"的完整分析

```bash
# 1. 从客户端看 DNS
time dig api.example.com

# 2. 看 TCP 建连耗时
curl -o /dev/null -s -w 'dns=%{time_namelookup} conn=%{time_connect} tls=%{time_appconnect} first=%{time_starttransfer} total=%{time_total}\n' https://api.example.com/

# 输出例：
# dns=0.012 conn=0.045 tls=0.098 first=1.230 total=1.245
```

**逐项判断**：

```
dns 大         → DNS 慢
conn 大        → 网络 RTT 高 / 丢包
tls 大         → TLS 握手慢（证书链长/算法弱）
first 大       → 服务端处理慢（应用/依赖）
total-first 大 → 响应体传输慢（带宽/大响应）
```

**这一步能在 10 秒内定位到"是哪一段慢"**，极其有用。

### 容器网络的特有坑

```bash
# 容器内
ip addr
ip route
cat /etc/resolv.conf
```

**四个常见**：

```
① 容器 DNS 指向 127.0.0.11（Docker 内嵌），宿主的 DNS 变了但容器没变
② MTU 不一致（overlay 网络 1450，容器里写 1500）→ 大包不通
③ iptables 规则冲突（Docker 与 firewalld）
④ 容器里没有 ping/nc/tcpdump（要装或用 nsenter）
```

**`nsenter` 进入容器网络命名空间**（容器里没工具时）：

```bash
PID=$(docker inspect -f '{{.State.Pid}}' <container>)
nsenter -t $PID -n ss -lntp
nsenter -t $PID -n tcpdump -i eth0 -nn
```

### 检查清单

```
□ 先 ip addr/route 确认本机网络
□ 用 nc 测端口，不只用 ping
□ DNS 用 dig +short / @指定服务器 / +trace
□ 路径用 mtr（不用 traceroute）
□ TLS 用 openssl s_client 看证书链与日期
□ 抓包用 -i any -nn -c 限制
□ 抓包看：握手/RST/重传/窗口
□ 用 curl -w 分段看耗时（dns/conn/tls/first/total）
□ 容器检查 DNS 与 MTU
□ 容器没工具用 nsenter
```
