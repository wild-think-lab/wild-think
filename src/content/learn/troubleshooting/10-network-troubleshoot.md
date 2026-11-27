---
title: 网络不通排查：从 ping 到抓包
module: 进阶篇
summary: 六层排查路径、每条命令的判据，以及"能 ping 通但服务不可用"的四种真实原因。
minutes: 50
---

### 六层路径

```
① 本机网卡/路由（ip a / ip r）
② 二层（ARP/邻居）
③ 三层（ping / traceroute）
④ 四层（端口 nc/telnet）
⑤ 七层（curl / 应用日志）
⑥ 中间设备（防火墙/NAT/代理/负载均衡）
```

### 逐层命令与判据

```bash
ip a; ip r
ip neigh
ping -c 3 10.0.0.21
traceroute -n 10.0.0.21
nc -zv 10.0.0.21 3306
curl -v --max-time 5 http://10.0.0.21:8080/
```

| 层 | 不通说明 |
| --- | --- |
| ping 不通 | 路由/防火墙 ICMP/主机宕 |
| ping 通但端口不通 | 服务未监听/端口防火墙 |
| 端口通但 HTTP 失败 | 应用层（TLS/路由/应用错） |
| 都通但偶发失败 | 丢包/超时/连接数 |

### "能 ping 通但服务不可用"的四种原因

**① 只监听 127.0.0.1**

```bash
ss -lntp | grep 8080
# 显示 127.0.0.1:8080 → 外部连不上
```

**② 防火墙只放了 ICMP**

```bash
firewall-cmd --list-all
iptables -S
```

**③ 中间有 NAT/代理改写**

```
源地址变了 → 后端按 IP 做白名单失败
```

**④ 端口通但应用拒绝**

```bash
curl -v http://...   # 看是 403/502 还是 reset
```

### 抓包（最后一招但最有效）

```bash
tcpdump -i eth0 -n host 10.0.0.21 and port 3306 -c 30 -w /tmp/x.pcap
tcpdump -i eth0 -n 'tcp[tcpflags] & (tcp-syn) != 0' -c 20
```

**读包要点**：

```
① 有 SYN 无 SYN-ACK → 对端没回（防火墙/未监听）
② SYN 后 RST → 端口关闭或被拒
③ 三次握手成功但没数据 → 应用层/TLS 问题
④ 大量重传 → 链路丢包
```

### DNS 专项

```bash
dig +short app.corp.local
dig @10.0.0.10 app.corp.local
cat /etc/resolv.conf
getent hosts app.corp.local
```

**"curl 慢 5 秒才连上"** 常见是 DNS 超时后回退。

### 五个"排查结论错"

**① 只在自己机器上测**

```
路径不同（NAT/代理），结论不同
```

**② 用域名测但怀疑 IP**

```
先分离 DNS 与连通性
```

**③ 忽略 MTU**

```
大包不通小包通 → MTU/分片问题
```

```bash
ping -M do -s 1472 10.0.0.21
```

**④ 忽略 conntrack 满**

```
dmesg | grep conntrack
```

**⑤ 只在通的时候看**

```
偶发问题必须看历史监控与抓包
```

### 检查清单

```
□ 从本机网卡/路由开始（不跳层）
□ 每层有明确判据
□ 区分 DNS 与连通性
□ 端口用 nc 验证（不只 ping）
□ 七层用 curl -v 看细节
□ 有中间设备清单（防火墙/NAT/代理）
□ 偶发问题抓包（存 pcap）
□ 检查 MTU 与 conntrack
□ 记录路径与源地址（NAT 后）
□ 结论带证据（命令输出/包）
```
