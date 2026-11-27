---
title: 第 3 章 · 暴露面收敛：把不用的门都关上
module: 入门篇
summary: 从"我的机器对外开了什么"入手，讲清端口收敛、管理面隔离、版本信息隐藏与云上安全组的正确姿势。
minutes: 18
---

### 第一步：知道自己开了什么

```bash
# 本机监听
ss -tlnp
# 从外部看（最真实）
nmap -Pn -p- --min-rate 1000 <你的公网IP>
```

**两个视角一定要对比**：本机 `ss` 看到的是"监听"，外部扫描看到的是"真的能连上"（中间可能有防火墙/NAT）。

### 三类高危端口

| 端口 | 服务 | 风险 |
| --- | --- | --- |
| 22 | SSH | 爆破、弱口令 |
| 3306 / 5432 | MySQL/PG | 拖库（最常见） |
| 6379 | Redis | 未授权访问 → 写 SSH key / 挖矿 |
| 9200 | Elasticsearch | 数据泄露 |
| 2375 / 2376 | Docker API | **直接 root** |
| 27017 | MongoDB | 未授权访问 |
| 8080 / 9090 | 管理后台 | 默认口令 |

**Docker API 暴露（2375）是最严重的一种**：可以直接创建特权容器拿到宿主机 root。

### 端口收敛的三个动作

**① 服务只监听内网**

```bash
# Redis
bind 10.0.0.10 127.0.0.1
# MySQL
bind-address = 10.0.0.10
# Nginx 管理端口
listen 127.0.0.1:8088;
```

**② 防火墙默认拒绝**

```bash
# firewalld
firewall-cmd --set-default-zone=drop
firewall-cmd --add-service=ssh --add-service=http --add-service=https
firewall-cmd --runtime-to-permanent

# ufw
ufw default deny incoming
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw enable
```

**③ 云安全组只放必要源**

```
差：0.0.0.0/0 → 22
好：办公出口 IP/32 → 22（或只开堡垒机 → 22）
```

### 管理面隔离

```
① 管理后台（Kibana/Grafana/Prometheus/Portainer）不放公网
② 需要远程访问时走 VPN 或堡垒机
③ 云上的"内网 SLB + 跳板"比"公网 IP + 密码"安全得多
```

**判断标准**：如果一个服务"只有 3 个人用"，它就不该在公网。

### 隐藏版本信息

```nginx
server_tokens off;                 # 不显示 nginx 版本
```

```bash
# PHP
expose_php = Off
# SSH banner（可选）
DebianBanner no
```

**这只是提高门槛**：真正决定安全的是补丁，不是隐藏 banner。但对自动化扫描机器人有效（它们优先打有已知版本的机器）。

### 补丁：暴露面的另一半

```
① 有已知漏洞的组件 = 暴露面
② 每月固定补丁窗口（不要"等出事再打"）
③ 关键组件单独跟踪（nginx、openssl、log4j 类）
```

```bash
# Ubuntu
apt list --upgradable
unattended-upgrade --dry-run -d

# CentOS
yum updateinfo list security
```

### 一个收敛案例

某内网服务器，收敛前扫描结果：

```
22   open
3306 open (0.0.0.0)
6379 open (0.0.0.0)
8080 open (管理后台，默认口令 admin/admin)
9200 open (ES，无认证)
```

收敛后：

```
22   open（仅堡垒机 IP 可达）
3306 closed（改 bind 10.0.0.10，应用走内网）
6379 closed（加密码 + bind 内网）
8080 closed（走 VPN）
9200 closed（前面加认证代理）
```

**没有买任何设备，只改了配置**。

### 定期复查

```bash
# 每周一次外网扫描（用 nmap 或云上的扫描服务）
nmap -Pn -p- --min-rate 1000 <公网IP> -oN scan.txt
diff scan-last.txt scan.txt        # 有新开的端口就查是谁开的
```

**新端口往往是"临时开的忘了关"**。这个 diff 是最有效的发现方式。

### 本章要点

```
① 内看 ss、外看 nmap，两者要对得上
② 数据库/缓存/ES/Docker API 绝不暴露公网
③ 防火墙默认拒绝，云安全组按源 IP 放通
④ 管理后台要么不放公网，要么加 VPN
⑤ 每月补丁 + 每周端口 diff
```
