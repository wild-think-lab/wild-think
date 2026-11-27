---
title: 自建 DNS 与 DHCP：内网里最不该出错的两个服务
description: 企业内网域名解析和地址分配怎么搭：dnsmasq 快速起步、BIND 主从、DHCP 与域环境的交互，以及故障时最先查什么。
date: 2026-11-27
tags: [DNS, DHCP, 内网服务, dnsmasq, BIND]
---

### 为什么这两个服务值得单独学

内网 80% 的"系统慢""打不开""登录不上"，最后都落在 DNS 或 DHCP 上。它们平时没人提，一出问题全公司停摆。

典型症状对照：

| 症状 | 大概率原因 |
| --- | --- |
| 能 ping IP，打不开域名 | DNS 服务器不可达或解析超时 |
| 打开网页要等 5 秒才响应 | DNS 超时后回退，多网卡配了错误的 DNS |
| 电脑拿到 169.254.x.x | DHCP 没响应，链路或作用域耗尽 |
| 域内机器开机登录很慢 | 域控 DNS 指错，SRV 记录查不到 |
| 新建机器能上网但加不进域 | DNS 指向了公网 DNS，而不是域控 |

### dnsmasq：小内网的最优解

一台机器上同时做 DNS 转发、本地域名、DHCP，配置十几行。

```bash
sudo apt install dnsmasq -y

# /etc/dnsmasq.conf
domain-needed
bogus-priv
no-resolv
server=223.5.5.5
server=119.29.29.29

# 本地域名（内网主机名解析）
address=/lab.local/10.10.10.20
host-record=db01.lab.local,10.10.10.31
host-record=web01.lab.local,10.10.10.32

# DHCP
dhcp-range=10.10.10.100,10.10.10.200,255.255.255.0,12h
dhcp-option=option-router,10.10.10.1
dhcp-option=option-dns,10.10.10.20
```

```bash
sudo systemctl restart dnsmasq
dig @10.10.10.20 db01.lab.local +short
grep -i dhcp /var/log/syslog | tail -5
```

优点：一个进程、配置集中、改完即生效。缺点：没有 DNSSEC、不适合超大规模、主从复制能力弱。

### BIND 主从：需要权威解析和冗余时

内网有几十台服务、需要多台 DNS 互为备份时，用 BIND。

主服务器 `named.conf.local`：

```
zone "lab.local" IN {
    type master;
    file "/etc/bind/db.lab.local";
    allow-transfer { 10.10.10.21; };
};
```

区文件（`db.lab.local`）要点：

```
$TTL 600
@   IN  SOA ns1.lab.local. admin.lab.local. (
        2026112701 ; serial，每次改必须递增
        3600 900 1209600 600 )
    IN  NS  ns1.lab.local.
    IN  NS  ns2.lab.local.
ns1 IN  A   10.10.10.20
ns2 IN  A   10.10.10.21
db01 IN A   10.10.10.31
```

从服务器只需 `type slave; masters { 10.10.10.20; };`。

**改完必做**：

```bash
sudo named-checkconf
sudo named-checkzone lab.local /etc/bind/db.lab.local
sudo rndc reload
dig @10.10.10.20 db01.lab.local +short
```

`serial` 忘了加是最常见的"改了不生效"原因——从库靠 serial 判断是否需要同步。

### DHCP 与域环境

如果内网有 AD，注意顺序：

1. DHCP 的 DNS 选项必须指向**域控**（域控本身提供 DNS），不能指向公网。
2. 域控做 DNS 时，正向区域自动带 `_msdcs`/`_sites` 等 SRV 记录，别手工删。
3. 不要在两台 DHCP 上配重叠的作用域，否则出现地址冲突（交换机日志会出现 MAC 冲突告警）。

租期建议：办公网 8–12 小时，访客网 1–2 小时，服务器一律静态。

### 排障三板斧

```bash
# 1. 解析是否通
dig @<dns-ip> <域名> +short
nslookup <域名> <dns-ip>

# 2. 客户端到底在用哪台 DNS
cat /etc/resolv.conf          # Linux
ipconfig /all                 # Windows

# 3. 服务端有没有收到查询
sudo tcpdump -i any -n udp port 53
sudo tail -f /var/log/syslog  # dnsmasq
```

顺序很重要：先确认客户端配置指向谁，再看服务端有没有收到包，最后才看记录内容。很多人一上来就翻区文件，结果问题在客户端配了两条互相矛盾的 DNS。

### 高可用与安全

- 至少两台 DNS，客户端主备都配上；或用 VIP + keepalived。
- 关闭递归对外（权威服务器 `allow-recursion { none; };`），否则会被当作反射放大器。
- 限制 53 端口只对内网开放，公网入口一律关掉。
- 日志保留 30 天，出事后能回查"谁在什么时候解析了什么"。

DNS 和 DHCP 的价值不在配置复杂度，而在**稳定**。把它们放到监控里，配一条"解析失败率"和"地址池使用率"的告警，比事后救火划算得多。
