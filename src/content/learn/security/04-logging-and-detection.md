---
title: 第 4 章 · 日志与检测：出了事多久能知道
module: 熟练篇
summary: 讲清"该记什么日志、记在哪、怎么用"，给出五条最有价值的检测规则和一条从告警到确认的完整链路。
minutes: 18
---

### 三类必须留的日志

| 类型 | 内容 | 保留 |
| --- | --- | --- |
| 认证日志 | 登录成功/失败、sudo、MFA | 6 个月+ |
| 变更日志 | 配置改动、软件安装、权限变更 | 1 年 |
| 访问日志 | Web 请求、API 调用、数据库查询 | 3–6 个月 |

**等保要求**：一般不少于 6 个月。留得比要求久一点，出事后才够查。

### 日志放哪（关键）

```
① 不能只放本机（被打进来第一件事就是清日志）
② 集中采集到独立日志服务器（打日志的人没有删日志的权限）
③ 关键日志再做一份异地（防勒索软件加密）
```

最小的集中方案：

```bash
# 客户端 rsyslog
*.* @@10.0.0.30:514

# 服务端 /etc/rsyslog.conf
module(load="imtcp")
input(type="imtcp" port="514")
template(name="perHost" type="string"
  string="/var/log/remote/%HOSTNAME%/%$YEAR%-%$MONTH%/%$DAY%.log")
*.* ?perHost
```

### 五条最有价值的检测规则

**① 暴力破解成功（最该告警）**

```
失败 N 次后成功登录 → 高危
正则：连续 >= 10 次 "Failed password" 后出现 "Accepted"
```

**② 异常时间/来源登录**

```
规则：成功的 SSH 登录来自非白名单 IP
或：凌晨 2–5 点的管理员登录（如果平时不这样）
```

**③ 新增账号 / 提权**

```bash
grep -E 'useradd|usermod|groupadd' /var/log/secure
awk -F: '($3==0){print}' /etc/passwd     # 定期比对
```

**④ 异常外联**

```
主动外连陌生 IP/域名（尤其是 3333/5555/14444 等矿池端口）
规则：出向连接的目标不在白名单
```

**⑤ Web 攻击特征**

```
日志里出现：union select、../..、${jndi:、select from information_schema
```

### 一条完整的链路

**场景**：Redis 未授权 → 攻击者写 SSH key → 登录 → 装挖矿。

| 环节 | 能留下的痕迹 |
| --- | --- |
| 写 key | `~/.ssh/authorized_keys` 修改（文件完整性监控） |
| 登录 | `Accepted publickey for root`（异常的 key 指纹） |
| 执行 | 进程树：`sshd → bash → curl → bash` |
| 挖矿 | 出向连 3333、CPU 100% |
| 持久化 | crontab 新增条目 |

**检测点**：①②④ 三条规则都能命中。所以规则不用多，要对。

### 文件完整性监控（FIM）

```bash
# aide 初始化
aide --init
mv /var/lib/aide/aide.db.new.gz /var/lib/aide/aide.db.gz
# 定期比对
aide --check
```

监控这些路径：

```
/etc/passwd, /etc/shadow, /etc/sudoers, /etc/ssh/sshd_config
~/.ssh/authorized_keys
/etc/cron*, /etc/systemd/system/
/usr/bin, /usr/sbin（二进制目录）
```

### Windows 侧

```powershell
# 安全日志关键事件 ID
# 4624 登录成功 / 4625 登录失败
# 4720 创建用户 / 4732 加入管理员组
# 7045 安装服务（常见持久化）
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625} -MaxEvents 20
```

### 日志本身的安全

```
① 日志服务器限制谁能查（不是所有开发都能看全量）
② 日志里的敏感字段要脱敏（见数据脱敏那篇）
③ 日志服务器单独加固（它是最有价值的目标之一）
④ 日志磁盘满会导致业务故障（要有轮转与告警）
```

### 本章要点

```
① 认证/变更/访问三类日志必须留，且集中到独立服务器
② 五条规则：爆破成功、异常登录、新增账号、异常外联、攻击特征
③ FIM 盯住账号、SSH、计划任务、二进制目录
④ 日志服务器自身要加固，且要脱敏
⑤ 检测的目标是"缩短发现时间"，不是"抓到所有人"
```
