---
title: 网络基础与配置：这台机器通不通
module: 入门篇
summary: ip/ss 的用法、路由与网关、DNS 解析、防火墙放行，以及"能 ping 通但不能访问"的五种原因。
minutes: 45
---

### 先看四件事

```bash
ip a                 # 地址（有没有 IP）
ip r                 # 路由（知道往哪发吗）
ss -lntp             # 监听（服务在听吗）
cat /etc/resolv.conf # DNS（域名能解析吗）
```

**"不通"** 的排查永远从这四条开始。

### 老命令与新命令对照

| 老 | 新 |
| --- | --- |
| ifconfig | `ip a` |
| route -n | `ip r` |
| netstat -lntp | `ss -lntp` |
| arp -a | `ip neigh` |
| iptables -L | `nft list ruleset` |

**"教程里都是 ifconfig"** → 新系统默认没装 net-tools，用 iproute2。

### 连接状态怎么读

```bash
ss -s                       # 汇总
ss -ant state established | wc -l
ss -antp | grep :443
```

**判据**：

```
ESTAB 多但业务无响应 → 应用层卡住（不是网络）
SYN-RECV 多 → 被 SYN 攻击或半开连接堆积
TIME-WAIT 多 → 短连接频繁（考虑连接复用）
```

### 路由与网关

```bash
ip r
# default via 10.0.0.1 dev eth0
ip route get 8.8.8.8      # 会告诉你"走哪条、从哪个源"
```

**多网卡时**：

```
默认路由只能有一条生效（策略路由除外）
→ 用 ip rule / 多表实现"按源地址选出口"
```

### DNS 解析

```bash
dig +short example.com
dig @8.8.8.8 example.com +trace
getent hosts example.com      # 走系统解析（含 /etc/hosts）
```

**"curl 能通但程序解析失败"** → 程序用了不同的解析器（如 Go 的 pure resolver 忽略 nsswitch）。

### 防火墙

```bash
# firewalld
firewall-cmd --list-all
firewall-cmd --add-service=http --permanent && firewall-cmd --reload

# nftables
nft list ruleset
```

**"端口在听但外部连不上"** → 本机防火墙 / 云安全组 / 上层 NAT 三层都要看。

### 五种"能 ping 通但不能访问"

**① 服务只监听 127.0.0.1**

```bash
ss -lntp | grep 8080   # 看是 0.0.0.0 还是 127.0.0.1
```

**② 本机防火墙拦了**

```
firewall-cmd --list-ports
```

**③ 云安全组/网络 ACL**

```
控制台里放行（本机看不到）
```

**④ 上层 NAT/端口映射错**

```
外部端口 8080 → 内部 80 没配对
```

**⑤ MTU / 大包被丢**

```bash
ping -M do -s 1400 <target>
```

**"ping 用的是 ICMP，业务用的是 TCP"** → ping 通不代表端口通，必须 `nc -zv` 或 `curl -v`。

### 一个"通不通"的判定脚本

```bash
host=example.com; port=443
getent hosts "$host" || echo "DNS 失败"
nc -zv -w3 "$host" "$port" || echo "端口不通"
curl -sS -o /dev/null -w "%{http_code}\n" "https://$host" || echo "HTTP 失败"
```

### 检查清单

```
□ 会 ip a / ip r / ss -lntp / dig 四条
□ 知道监听地址 0.0.0.0 与 127.0.0.1 的差别
□ 会看 ESTAB/TIME-WAIT/SYN-RECV 的含义
□ 知道"本机防火墙 / 安全组 / NAT"三层
□ 会用 nc 测端口
□ 会 ip route get 判断出口
□ 知道 MTU 会引发"大包不通"
□ 有连通性自检脚本
```
