---
title: 服务器上线前的 60 项检查
description: 一份能直接用的上线检查表：系统、安全、网络、服务、监控、备份六大块，每项都有验证命令。
date: 2023-03-19
tags: [运维, 上线, 检查清单, SRE]
---

### 怎么用这份清单

```
① 只查"这一台机器要做什么"相关的项（不是每台都全查）
② 每项都有验证命令，不是"确认一下"
③ 上线清单要签字（谁查的、什么时候）
```

### 一、系统基础（10 项）

```bash
# 1. 主机名正确
hostnamectl
# 2. 时间同步
timedatectl status     # 看 System clock synchronized: yes
chronyc sources -v
# 3. 时区正确
timedatectl | grep "Time zone"
# 4. 系统版本与补丁
cat /etc/os-release
uname -r
# 5. 磁盘分区与挂载
df -h
findmnt
# 6. 内存与 swap
free -h
# 7. 内核参数（文件句柄、连接数）
sysctl net.core.somaxconn fs.file-max
ulimit -n
# 8. 关闭不必要的服务
systemctl list-unit-files --state=enabled
# 9. 有监控 agent
systemctl status node_exporter
# 10. 有配置管理与基线（谁装的、装了什么）
```

### 二、安全加固（14 项）

```bash
# 11. SSH 禁止 root 直登
grep "PermitRootLogin" /etc/ssh/sshd_config
# 应为 no 或 prohibit-password

# 12. SSH 禁用密码登录（用密钥）
grep "PasswordAuthentication" /etc/ssh/sshd_config   # 应为 no

# 13. SSH 端口（改端口只是减少噪音，不是安全措施）
# 14. 有 fail2ban 或等效
systemctl status fail2ban

# 15. 防火墙开启且规则最小
firewall-cmd --list-all      # 或 iptables -L -n
# 16. 只开放必要端口
ss -lntp

# 17. 系统补丁已打
# RHEL: yum update --security
# Debian: unattended-upgrades

# 18. SELinux/AppArmor 状态
getenforce     # 或 aa-status

# 19. 无弱口令/默认口令
# 20. 普通用户有 sudo 权限管控
visudo -c
# 21. 登录审计开启
last / lastb
# 22. 关键文件权限
ls -l /etc/passwd /etc/shadow

# 23. 无免密 sudo 通配
grep -r "NOPASSWD" /etc/sudoers /etc/sudoers.d/

# 24. 有堡垒机或跳板（不能直连生产）
```

### 三、网络（8 项）

```bash
# 25. IP/掩码/网关正确
ip addr; ip route
# 26. DNS 可用
cat /etc/resolv.conf
dig +short www.example.com
# 27. 能出网（如需要）
curl -sI https://mirrors.example.com | head -1
# 28. 端口对外可达（从另一台测）
nc -vz <ip> <port>
# 29. MTU 正确（特别是 overlay 网络）
ip link show | grep mtu
ping -M do -s 1472 <ip>      # 1500 MTU 时可通
# 30. 双网卡（业务/管理分离）
# 31. 有 IPv6（如需要）
ip -6 addr
# 32. 流量与连接数没有异常
ss -s
```

### 四、服务（12 项）

```bash
# 33. 服务用 systemd 管理（不是裸跑）
systemctl status app
# 34. 有 unit 文件且在 /etc/systemd/system
# 35. 开机自启
systemctl is-enabled app
# 36. 以非 root 用户运行
ps -o user= -p $(pgrep -f app | head -1)
# 37. 配置外置（不在代码里）
# 38. 日志输出到 journal 或文件（不是 /dev/null）
journalctl -u app -n 20
# 39. 日志有轮转
ls /etc/logrotate.d/
# 40. 有健康检查端点
curl -s localhost:8080/healthz
# 41. 有优雅关闭
# 42. 资源限制（systemd 或 cgroup）
systemctl show app | grep -E "MemoryMax|CPUQuota"
# 43. 端口不与已有服务冲突
ss -lntp | grep <port>
# 44. 有 runbook（出问题怎么办）
```

### 五、监控与告警（8 项）

```bash
# 45. 主机监控（CPU/内存/磁盘/网络）
# 46. 服务可用性监控（探针）
# 47. 磁盘容量告警（阈值 75%/85%）
# 48. 内存告警
# 49. 关键进程/端口监控
# 50. 日志错误监控（错误数突增）
# 51. 有告警接收人与升级路径
# 52. 有仪表盘（一眼看健康）
```

**验证方式**：

```
人为触发一次告警（如临时打满磁盘的 1%），确认能收到
```

### 六、备份与恢复（8 项）

```bash
# 53. 有备份任务且在跑
systemctl list-timers | grep backup
# 54. 备份有保留策略（不是无限增长）
# 55. 备份在异地/异机（不是同一台）
# 56. 有恢复演练记录（最近一次是什么时候）
# 57. 关键配置在版本控制里
# 58. 有快照/镜像可回退（上线前必做）
# 59. 备份加密（含敏感数据时）
# 60. 有"恢复需要多久"的预估（RTO）
```

**"备份没验证过等于没有备份"**——这一条最容易漏。

### 上线当天的额外动作

```
① 记录基线（CPU/内存/磁盘/连接数/延迟）
② 开放监控（确认数据在采）
③ 通知相关方（谁在上线、影响什么）
④ 准备回滚（快照/旧版本镜像/回滚命令）
⑤ 灰度（如可能：10% → 50% → 100%）
⑥ 上线后 30 分钟观察（错误率/延迟/资源）
```

### 一份可打印的简版

```markdown
[ ] 主机名/时间/时区
[ ] 磁盘/inode/挂载
[ ] ssh 禁 root + 禁密码
[ ] 防火墙最小开放
[ ] 补丁已打
[ ] 端口对外可达（从外部测过）
[ ] 服务 systemd 管理 + 自启
[ ] 非 root 运行
[ ] 日志有轮转
[ ] 健康检查端点
[ ] 主机 + 服务监控已接入
[ ] 告警能收到（测过）
[ ] 备份在跑 + 异地 + 演练过
[ ] 有快照可回退
[ ] 有 runbook
[ ] 基线已记录
```

### 检查清单（对清单本身）

```
□ 清单有验证命令（不是"确认一下"）
□ 有人签字（谁查的、时间）
□ 只查相关项（不一刀切）
□ 上线前必做快照
□ 上线后 30 分钟观察
□ 告警触发验证过
□ 备份恢复演练过
□ 清单每季度更新（踩过的坑补进去）
```
