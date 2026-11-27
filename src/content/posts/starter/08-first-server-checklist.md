---
title: 第一台服务器上线前，这 20 项必须过一遍
description: 一份可直接照着执行的清单：系统层、网络层、账号与安全、服务层、监控与备份，每项都给出检查命令与通过标准。
date: 2026-11-27
tags: [入门, 上线清单, 加固, 运维]
---

### 为什么需要清单

新人上线第一台服务器，最常见的三个问题：

```
① 能跑起来，但重启后起不来（服务没设开机自启）
② 能访问，但外网能扫到管理端口
③ 能运行，但没人知道它挂了（没有监控）
```

清单的作用是**把"我以为"换成"我验证过"**。

### 一、系统层（5 项）

**1. 系统版本与内核**

```bash
cat /etc/os-release; uname -r
```

通过标准：与规划一致（别装成了不同发行版）。

**2. 时间同步**

```bash
timedatectl; chronyc sources -v
```

通过标准：`System clock synchronized: yes`，时区为 `Asia/Shanghai`。

时间不同步会导致：日志时间错乱、TLS 证书校验失败、分布式锁异常。

**3. 磁盘分区与挂载**

```bash
df -hT; lsblk; cat /etc/fstab
```

通过标准：

- 数据盘单独挂载（不要都放根分区）。
- fstab 里非关键挂载有 `nofail`。
- 根分区剩余 > 30%。

**4. 内存与 swap**

```bash
free -h; swapon --show
```

通过标准：swap 按需（数据库建议关闭或设很小），`vm.swappiness` 已调整。

**5. 内核参数**

```bash
sysctl -p; cat /etc/sysctl.d/99-tuning.conf
```

常用项：

```ini
net.core.somaxconn = 32768
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.ip_local_port_range = 10000 65000
net.ipv4.tcp_tw_reuse = 1
fs.file-max = 1000000
vm.swappiness = 10
```

### 二、网络层（4 项）

**6. IP 与路由**

```bash
ip -4 addr; ip route
```

通过标准：IP、网关、DNS 正确，能 ping 通网关。

**7. 主机名与解析**

```bash
hostnamectl; cat /etc/hosts
```

通过标准：主机名规范（如 `prod-api-01`），`/etc/hosts` 有本机映射。

**8. 防火墙**

```bash
firewall-cmd --list-all       # CentOS
ufw status verbose            # Ubuntu
```

通过标准：**默认拒绝入向**，只放通业务端口（22/80/443/业务端口）。**不要放通 3306/6379/9200 到公网**。

**9. 端口占用检查**

```bash
ss -tlnp
```

通过标准：只监听必要端口，管理端口（如 9090、8080 后台）绑 127.0.0.1 或内网。

### 三、账号与安全（5 项）

**10. 禁止 root 直接登录**

```bash
grep -E '^PermitRootLogin' /etc/ssh/sshd_config
```

通过标准：`PermitRootLogin no`（或 `prohibit-password`）。

**11. 密钥登录，关闭密码**

```bash
grep -E '^(PubkeyAuthentication|PasswordAuthentication)' /etc/ssh/sshd_config
```

通过标准：`PubkeyAuthentication yes`、`PasswordAuthentication no`。

**12. sudo 权限收敛**

```bash
cat /etc/sudoers.d/*; getent group sudo wheel
```

通过标准：只有指定账号有 sudo，且命令有审计（`Defaults logfile`）。

**13. 账号与密码**

```bash
awk -F: '$3>=1000 && $3<65534 {print $1}' /etc/passwd
```

通过标准：无多余账号，UID 0 账号只有一个 root。

**14. 自动安全更新（可选）**

```bash
# Ubuntu
dpkg -l unattended-upgrades
```

通过标准：至少"安全更新"自动装，或每月人工窗口。

### 四、服务层（3 项）

**15. 服务开机自启**

```bash
systemctl list-unit-files --state=enabled | head -20
systemctl is-enabled nginx
```

通过标准：**所有必须的服务都是 enabled**。

**16. 服务以非 root 运行**

```bash
ps -eo user,pid,cmd | grep -E 'nginx|java|python' | head
```

通过标准：业务进程用专用低权限账号（不是 root）。

**17. 日志与轮转**

```bash
ls /etc/logrotate.d/
du -sh /var/log
```

通过标准：有 logrotate 配置（按天/大小轮转，保留 7–30 天），日志盘不写满根分区。

### 五、监控与备份（3 项）

**18. 监控采集**

```bash
systemctl status node_exporter
curl -s localhost:9100/metrics | head
```

通过标准：CPU/内存/磁盘/网络指标已被 Prometheus 采集到（在 Grafana 里能看到这台机器）。

**19. 告警规则**

通过标准：**至少三条**——机器宕机、磁盘 > 85%、服务端口不可用。

**20. 备份**

```bash
ls /backup; crontab -l | grep backup
```

通过标准：关键数据有定期备份（每天），且**验证过一次恢复**（没验证过的备份不算备份）。

### 一份汇总检查脚本

```bash
#!/usr/bin/env bash
set -uo pipefail
ok(){ printf '  [OK]   %s\n' "$1"; }
warn(){ printf '  [WARN] %s\n' "$1"; }
bad(){ printf '  [FAIL] %s\n' "$1"; }

echo "=== 系统"
grep -q 'synchronized: yes' <(timedatectl) && ok "时间同步" || bad "时间同步"
rootuse=$(df / --output=pcent | tail -1 | tr -d ' %')
[[ $rootuse -lt 70 ]] && ok "根分区 ${rootuse}%" || warn "根分区 ${rootuse}%"

echo "=== 网络"
ss -tlnp | grep -q ':22 ' && ok "SSH 监听" || bad "SSH 未监听"
if ss -tlnp | grep -qE '0\.0\.0\.0:(3306|6379|9200)'; then
  bad "数据库/中间件端口暴露在 0.0.0.0"
else ok "无敏感端口暴露"; fi

echo "=== 安全"
grep -qE '^PermitRootLogin (no|prohibit-password)' /etc/ssh/sshd_config && ok "禁止 root 登录" || warn "允许 root 登录"
grep -qE '^PasswordAuthentication no' /etc/ssh/sshd_config && ok "禁用密码登录" || warn "允许密码登录"

echo "=== 服务"
for s in nginx; do
  systemctl is-enabled "$s" >/dev/null 2>&1 && ok "$s 已开机自启" || warn "$s 未设自启"
done

echo "=== 监控"
systemctl is-active node_exporter >/dev/null 2>&1 && ok "node_exporter 运行中" || bad "无监控采集"

echo "=== 备份"
ls /backup >/dev/null 2>&1 && ok "备份目录存在" || warn "无备份目录"
```

### 清单的使用方式

```
① 上线当天逐项打勾（真的执行命令，不靠猜）
② 把脚本存进仓库，每次新机器都用
③ 每季度抽查一次（服务器会"漂移"）
```

### 检查清单（浓缩版）

```
系统：版本 / 时间同步 / 分区 / 内存 / 内核参数
网络：IP 路由 / 主机名 / 防火墙默认拒绝 / 只监听必要端口
安全：禁 root 登录 / 密钥登录 / sudo 收敛 / 无多余账号 / 自动安全更新
服务：开机自启 / 非 root 运行 / 日志轮转
监控：指标采集 / 三条告警 / 备份且验证过恢复
```
