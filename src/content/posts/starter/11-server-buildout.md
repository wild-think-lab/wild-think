---
title: 新服务器上线：从零到"能放心交出去"
description: 十步上线流程、每一步的验证命令，以及五个"装完就上线"埋下的雷。
date: 2026-11-27
tags: [入门, 运维, 服务器]
---

### 十步流程

```
① 装机与分区
② 网络与主机名
③ 时区与时间同步
④ 安全基线（SSH/防火墙/SELinux）
⑤ 软件源与基础包
⑥ 内核参数与文件句柄
⑦ 监控与日志接入
⑧ 备份与定时任务
⑨ 业务部署（容器或二进制）
⑩ 验收与文档
```

**"跳过第 ③④⑦ 步"是最常见的偷懒**，也是最容易在半年后爆的。

### ① 分区

```
/boot   1G
/       50–100G
/var    单独（日志与容器容易涨）
/data   剩余（业务数据）
swap    服务器一般关（或用小 swap 兜底）
```

**"所有东西都放 /"** → 日志一涨就整机不可用。

### ② 网络

```bash
hostnamectl set-hostname app-01
nmcli con mod eth0 ipv4.addresses 10.0.0.21/24
nmcli con mod eth0 ipv4.gateway 10.0.0.1
nmcli con mod eth0 ipv4.dns "10.0.0.2"
nmcli con up eth0
ip a; ip r; cat /etc/resolv.conf
ping -c2 10.0.0.1; ping -c2 baidu.com
```

**"DNS 没通"** 会导致后面所有包管理操作失败。

### ③ 时区与时间

```bash
timedatectl set-timezone Asia/Shanghai
timedatectl set-ntp true
chronyc sources -v
timedatectl
```

**"时间偏差 > 5 分钟"** 会让证书校验、Kerberos、日志对齐全部出问题。

### ④ 安全基线

```bash
# SSH
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config
systemctl restart sshd

# 防火墙
firewall-cmd --permanent --add-service=ssh
firewall-cmd --reload

# SELinux（不要关，配置对就好）
getenforce
```

**"先确认密钥能登录，再关密码登录"** —— 否则会把自己锁在外面。

### ⑤ 软件源

```bash
# CentOS 7 已 EOL，需要换 vault 源
sed -i 's/mirrorlist/#mirrorlist/g' /etc/yum.repos.d/CentOS-*.repo
sed -i 's|#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g' /etc/yum.repos.d/CentOS-*.repo
yum clean all && yum makecache
```

**"yum 全部 404"** 基本都是 EOL 源问题。

### ⑥ 内核参数

```bash
cat >> /etc/sysctl.d/99-tuning.conf <<'EOF'
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
fs.file-max = 1000000
vm.swappiness = 10
EOF
sysctl -p /etc/sysctl.d/99-tuning.conf
```

```bash
cat >> /etc/security/limits.d/99-nofile.conf <<'EOF'
* soft nofile 100000
* hard nofile 100000
EOF
```

**"高并发下连接被拒"** 多半是 somaxconn/backlog 太小。

### ⑦ 监控与日志

```bash
# node_exporter
# 日志转发（rsyslog 或 fluent-bit）
```

**"上线两周才发现没接监控"** 很常见，也很致命。

### ⑧ 备份与定时

```bash
crontab -e
# 0 2 * * * /usr/local/bin/backup.sh
```

**先写"能跑通一次"的备份脚本，再加 cron**。

### ⑨ 业务部署

```
容器：docker/podman + compose 或 k8s
二进制：systemd unit（含 Restart=always）
```

**systemd unit 是最稳的"守护进程"方案**：

```ini
[Service]
Restart=always
RestartSec=5
```

### ⑩ 验收

```bash
# 网络
ping / curl / ss -lntp
# 资源
top / df -h / free -m
# 服务
systemctl status xxx
# 日志
journalctl -u xxx -n 50
# 安全
ss -lntp   # 确认只监听必要端口
```

**"验收清单逐项打勾"** 而不是"感觉没问题"。

### 五个"装完就上线"埋下的雷

**① 密码登录开着 + 弱密码**

```
公网 IP 一天被扫几百次
```

**② 没接监控**

```
出事时"没人知道挂了多久"
```

**③ 时区/时间不对**

```
日志时间错乱，跨系统排查像猜谜
```

**④ 系统盘与数据盘混用**

```
日志/容器把 / 写满 → 整机不可用
```

**⑤ 没有回滚路径**

```
升级失败后"只能硬扛"
```

### 检查清单

```
□ 分区合理（/var 与 /data 独立）
□ 主机名/网络/DNS 通
□ 时区正确 + NTP 同步
□ SSH 禁 root 密码登录 + 密钥可用
□ 防火墙只开必要端口
□ 软件源可用（EOL 系统换 vault）
□ 内核参数与 fd 上限已调
□ 监控/日志已接入
□ 备份脚本跑通 + cron
□ 业务以 systemd/容器运行（有重启策略）
□ 验收清单逐项通过
□ 有文档（IP/端口/账号归属/回滚步骤）
```
