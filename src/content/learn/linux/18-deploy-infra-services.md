---
title: 部署内网基础服务：DNS / DHCP / NTP
module: 进阶篇
summary: 自建 DNS（dnsmasq/BIND）、DHCP 保留地址、NTP 时间同步,以及五个"内网服务互相打架"的原因。
minutes: 45
---

### 为什么自建

```
① 内网域名解析（app.corp.local）
② 统一出口与缓存（加速 + 减少外网查询）
③ 时间同步（证书/日志/集群一致性）
④ 地址自动分配（办公网/实验环境）
```

**"全靠外网 DNS"** → 内网服务要用 IP，迁移困难。

### dnsmasq：小网络够用

```bash
dnf install -y dnsmasq
```

```conf
# /etc/dnsmasq.conf
domain-needed
bogus-priv
no-resolv
server=223.5.5.5
server=8.8.8.8
local=/corp.local/
address=/app.corp.local/10.0.0.20
address=/db.corp.local/10.0.0.21
```

```bash
systemctl enable --now dnsmasq
dig @127.0.0.1 app.corp.local +short
```

**"把内网域名配在上游 DNS"** → 上游不知道，解析失败。

### BIND：正经的内网权威

```conf
// named.conf 片段
zone "corp.local" {
    type master;
    file "/var/named/corp.local.zone";
};
```

```conf
; corp.local.zone
$TTL 600
@   IN SOA ns1.corp.local. admin.corp.local. (2026112701 3600 600 86400 600)
@   IN NS  ns1.corp.local.
ns1 IN A   10.0.0.10
app IN A   10.0.0.20
db  IN A   10.0.0.21
```

```bash
named-checkzone corp.local /var/named/corp.local.zone
rndc reload
```

**"手改 zone 不检查"** → 语法错会让整个 zone 不加载。

### DHCP：保留地址

```conf
# dnsmasq
dhcp-range=10.0.0.100,10.0.0.200,12h
dhcp-option=3,10.0.0.1
dhcp-option=6,10.0.0.10
dhcp-host=aa:bb:cc:dd:ee:ff,10.0.0.50    # 打印机固定 IP
```

**要点**：

```
① 地址池不要与静态 IP 重叠
② 网关与 DNS 通过 option 下发
③ 关键设备（打印机/AP/服务器）用保留
```

### NTP：时间必须一致

```bash
dnf install -y chrony
```

```conf
# /etc/chrony.conf
server ntp.aliyun.com iburst
server time.cloudflare.com iburst
allow 10.0.0.0/24        # 允许内网客户端同步
local stratum 10
```

```bash
systemctl enable --now chronyd
chronyc sources -v
chronyc tracking
```

**判据**：

```
System time offset < 50ms（一般够）
过大 → 检查上游可达与防火墙（UDP 123）
```

**"集群时间差几分钟"** → 证书校验失败、日志错乱、分布式锁异常。

### 五个"内网服务互相打架"

**① 两套 DHCP**

```
一个路由器 + 一台服务器都发地址 → 地址冲突
```

**② 环路 + DHCP**

```
DHCP 请求在环路里打转 → 地址池耗尽
```

**③ DNS 双份答案**

```
dnsmasq 与 BIND 都配置了不同记录
```

**④ 时间源不一致**

```
部分机器同步外网、部分同步内网 → 差几秒
```

**⑤ 防火墙挡了基础协议**

```
UDP 53/67/68/123 被拦 → "莫名其妙不能上网"
```

### 一个"够用"的内网基础服务清单

```
① 一台 DNS（dnsmasq 或 BIND），内网域名 + 上游转发
② DHCP（地址池 + 保留）
③ NTP（内网一主一备，客户端指向内网）
④ 监控：解析成功率、地址池使用率、时间偏移
```

### 检查清单

```
□ 内网域名有记录（不是写 IP）
□ DHCP 只有一套
□ 地址池不与静态重叠
□ 关键设备有保留
□ NTP 内网源 + 客户端统一
□ 基础协议端口放行
□ 有解析/池/偏移监控
□ 有备份配置
□ 变更前 named-checkzone/语法检查
□ 有回滚（保留上一版配置）
```
