---
title: 安全评估自查：不请渗透公司也能先查出大部分问题
description: 五个方向的自查清单（资产/账号/暴露面/配置/数据），每项配可执行的检查命令。
date: 2026-04-03
tags: [安全, 自查, 加固]
---

### 为什么要自查

```
渗透测试能发现"能被利用的"
自查能发现"明显不该存在的"
→ 后者成本低、覆盖广，先做
```

### 一、资产：到底有什么在跑

```bash
# 监听端口
ss -lntp
# 运行中的服务
systemctl list-units --type=service --state=running
# 容器
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
# 进程
ps -eo pid,user,cmd --sort=-%cpu | head -20
```

**"清单里有你不知道的服务"** → 这就是第一个风险。

### 二、账号：谁有钥匙

```bash
# 可登录用户
awk -F: '$7 !~ /nologin|false/ {print $1, $7}' /etc/passwd
# sudo 权限
grep -r "^.*ALL" /etc/sudoers /etc/sudoers.d/ 2>/dev/null
# 最近登录
last -20
# 失败登录
journalctl -u sshd | grep "Failed password" | tail -20
```

**重点**：

```
① 有没有"测试账号"还留着
② 有没有"共享账号"（无法追责）
③ sudo 是否最小化
```

### 三、暴露面：哪些能被外面看到

```bash
# 从外部视角扫（只扫自己的资产！）
nmap -sT -Pn -p- --min-rate 1000 <your-ip>
# 云安全组规则
# 控制台看"入方向 0.0.0.0/0"
```

**"公网开着的 22/3306/6379"** 是最常见的高危。

```bash
# 本机确认
ss -lntp | grep -E ':22|:3306|:6379|:9200'
```

### 四、配置：明显的错误

```bash
# SSH
sshd -T | grep -E "permitrootlogin|passwordauthentication|maxauthtries"
# 文件权限
find / -perm -4000 -type f 2>/dev/null          # SUID
ls -l /etc/shadow /etc/passwd
# Web 目录
find /var/www -name "*.bak" -o -name "*.sql" -o -name ".env" 2>/dev/null
# 硬编码密钥
grep -rn "password\|secret\|token" /var/www --include="*.php" | head
```

**"web 目录里的 .env / backup.sql"** 是数据泄露的经典入口。

### 五、数据：备份与加密

```bash
# 备份是否可访问
ls -ld /backup
# 数据库是否有弱口令
mysql -uroot -p'' -e "select 1" 2>&1 | head -1
# 敏感数据是否明文
grep -rn "id_card\|phone" /var/log 2>/dev/null | head
```

**"日志里明文手机号"** 是合规与泄露双重风险。

### 一个"半天能做完"的自查表

| 方向 | 检查 | 常见问题 |
| --- | --- | --- |
| 资产 | 监听端口/服务清单 | 遗留测试服务 |
| 账号 | 可登录用户/ sudo | 共享账号、过度 sudo |
| 暴露面 | 公网端口 | 22/3306/6379 暴露 |
| 配置 | SSH/权限/备份文件 | 密码登录、SUID、.env |
| 数据 | 备份/日志/加密 | 备份可下载、日志明文 |

### 五个"自查也会漏"的地方

**① 只查了服务器，没查"云控制台"**

```
安全组、对象存储公共读、快照公共访问 —— 都不在服务器上
```

**② 只查了"应用"，没查"中间件默认页"**

```
Tomcat manager / ES / Kibana 默认无认证
```

**③ 只查了"现在"，没查"历史"**

```
旧的备份/日志里可能还有已删除的敏感数据
```

**④ 只查了"外部"，没查"横向"**

```
一台机器被拿下 → 内网其他机器是否"信任它"
```

**⑤ 只查了"技术"，没查"流程"**

```
离职员工账号、临时开放的端口、过期的白名单
```

### 检查清单

```
□ 有端口/服务清单（并定期更新）
□ 可登录用户清单 + sudo 最小化
□ 公网暴露面清单（含云安全组）
□ SSH 禁密码登录 + 禁 root
□ 无 web 目录备份文件/配置文件泄露
□ 无 SUID 异常文件
□ 数据库无弱口令、不对公网
□ 中间件（ES/Kibana/Tomcat）有认证
□ 备份不可公开访问
□ 日志无明文敏感信息
□ 有"离职/临时开放"的清理流程
□ 自查按季度做，结果归档
```
