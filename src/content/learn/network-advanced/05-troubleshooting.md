---
title: 排障：不通的十种情形与对应证据
module: 进阶篇
summary: 十种"访问不通"的真实原因，每种配一条能定论的命令，形成可复用的排查表。
minutes: 35
---

### 为什么需要这张表

```
"不通"是最模糊的描述
→ 把它拆成十种具体情形，每种只需要一条命令就能排除
```

### 十种情形

**① 服务没监听**

```bash
ss -lntp | grep :8080
```

**② 监听在 127.0.0.1**

```bash
ss -lntp | grep 8080
# 看 Local Address 是 0.0.0.0 还是 127.0.0.1
```

**③ 主机防火墙拦**

```bash
firewall-cmd --list-all
iptables -L -n -v | head
```

**④ 云安全组拦**

```
平台控制台看"入方向规则"
（这条不看就永远找不到）
```

**⑤ 路由不对/无回程**

```bash
ip route get <dst>
traceroute -n <dst>
```

**⑥ DNS 解析错**

```bash
getent hosts <domain>
dig +short <domain>
```

**⑦ 端口转发/映射错**

```bash
# 在转发机上确认 DNAT 规则与目标端口
iptables -t nat -L -n -v
```

**⑧ TLS/证书失败**

```bash
openssl s_client -connect host:443 -servername host </dev/null 2>&1 | head -20
```

**⑨ MTU 问题（小包通，大包不通）**

```bash
ping -M do -s 1400 <dst>     # 禁止分片，测大包
```

**⑩ 应用层拒绝（协议/鉴权）**

```bash
curl -v <url>
# 看 401/403/400 与响应体
```

### 一张"决策表"

| 现象 | 最可能 | 一条命令 |
| --- | --- | --- |
| Connection refused | 服务没起/防火墙 REJECT | `ss -lntp` |
| timed out | 丢包/DROP/路由 | `traceroute -n` |
| 域名解析失败 | DNS | `dig +short` |
| ping 通但端口不通 | 防火墙/服务 | `nc -zv host port` |
| 小请求通、大请求断 | MTU | `ping -M do -s 1400` |
| 证书错误 | 证书链/时间 | `openssl s_client` |
| 偶发失败 | 后端不健康/连接池 | 看后端健康与连接数 |

### 三个"顺序"原则

```
① 由近及远：本机 → 同网段 → 跨网段 → 公网
② 由下往上：链路 → 网络 → 传输 → 应用
③ 由静到动：静态配置先确认，再抓动态包
```

**"跳步"是浪费时间的主要原因**。

### 一个可复用的脚本

```bash
#!/usr/bin/env bash
# usage: netcheck.sh host port
h=$1; p=$2
echo "== dns =="; getent hosts "$h" || echo "DNS FAIL"
echo "== tcp =="; timeout 3 bash -c "</dev/tcp/$h/$p" && echo "TCP OK" || echo "TCP FAIL"
echo "== tls =="; timeout 5 openssl s_client -connect "$h:$p" -servername "$h" </dev/null 2>&1 | grep -E "Verify return|Protocol"
echo "== http =="; curl -sS -o /dev/null -m 5 -w 'code=%{http_code} ttfb=%{time_starttransfer}\n' "https://$h:$p/" || true
```

**"一条脚本跑完四层"** 比逐个试快得多。

### 进阶：把结论写成 runbook

```
现象：X 服务 502
判据：nginx 日志 upstream timed out / connection refused
步骤：1) 查后端监听 2) 查后端健康 3) 查连接池 4) 查超时配置
止损：切备用后端 / 重启后端
```

**"runbook 写给自己三个月后看"** —— 那时你会感谢自己。

### 小结

```
① 把"不通"拆成十种具体情形
② 每种一条命令定论
③ 由近及远、由下往上
④ 有一键脚本
⑤ 结论沉淀成 runbook
```
