---
title: 第 2 章 · 账号与权限：把"谁能做什么"管住
module: 入门篇
summary: 从最小权限讲到 MFA、从 sudo 审计讲到密钥轮换，给出可直接落地的账号治理清单与命令。
minutes: 18
---

### 最小权限的三个具体动作

```
① 能不给 root 就不给（用专用账号 + sudo 特定命令）
② 能用只读就不给写权限（数据库账号按需分配）
③ 用完就回收（临时账号、临时密钥设到期时间）
```

**"临时"必须真的临时**：给临时账号加个到期日，而不是靠人记。

### sudo 的精细化

```bash
# /etc/sudoers.d/ops
# 只允许重启指定服务
ops ALL=(root) NOPASSWD: /bin/systemctl restart nginx, /bin/systemctl status nginx
# 允许看日志但不能删
ops ALL=(root) NOPASSWD: /usr/bin/journalctl, !/usr/bin/rm
```

**审计**：

```bash
# /etc/sudoers
Defaults logfile=/var/log/sudo.log
Defaults log_input, log_output
Defaults iolog_dir=/var/log/sudo-io
```

`log_input`/`log_output` 会记录**执行的命令与输出**，出事后能回放。

### SSH 的六项加固

```bash
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
AllowUsers ops deploy
ClientAliveInterval 300
ClientAliveCountMax 2
```

```bash
sshd -t && systemctl reload sshd      # 改完先测语法
```

**注意**：改 `PasswordAuthentication no` 前**先确认密钥能登录**，否则会把自己锁在外面。

### MFA 的落地位置

```
① 堡垒机（最优先，所有运维入口收口）
② VPN
③ 云控制台（云账号被盗比服务器被入侵更危险）
④ 代码仓库的管理员账号
```

TOTP 是最容易落地的（手机 App 扫码），硬件 key 更安全但成本高。

**MFA 不要只做"登录时"**：敏感操作（改权限、删数据）可以二次验证。

### 密钥管理

**四条规则**：

```
① 私钥不落 Git（用 secret 扫描拦住）
② 私钥权限 600，且有 passphrase（或用 agent）
③ 定期轮换（至少每年，离职必换）
④ 一个用途一个密钥（不要一把钥匙开所有门）
```

扫描仓库里的密钥：

```bash
# gitleaks
gitleaks detect --source . --verbose
# trufflehog
trufflehog git file://. --only-verified
```

**接入 CI**，每次 PR 都扫，比"事后检查"有效得多。

### 僵尸账号清理

```bash
# Linux：看最近登录时间
lastlog | grep -v 'Never'
# 空密码账号
awk -F: '($2==""){print $1}' /etc/passwd
# UID 0 账号（应该只有 root）
awk -F: '($3==0){print $1}' /etc/passwd
```

Windows：

```powershell
Get-LocalUser | Where Enabled -eq $true | Select Name, LastLogon
# 域内（需要 RSAT）
Get-ADUser -Filter * -Properties LastLogonDate | Where {$_.LastLogonDate -lt (Get-Date).AddDays(-90)}
```

**规则**：90 天未登录的非服务账号 → 禁用（不是删除，先禁用观察）。

### 数据库账号

```sql
-- 只读账号（报表用）
CREATE USER 'report'@'10.%' IDENTIFIED BY 'xxx';
GRANT SELECT ON app.* TO 'report'@'10.%';

-- 检查是否有过宽权限
SELECT user, host FROM mysql.user WHERE Super_priv='Y' OR Grant_priv='Y';

-- 检查空密码/弱账号
SELECT user, host, plugin FROM mysql.user WHERE user='root';
```

**常见错误**：`GRANT ALL ON *.* TO 'app'@'%'`——应用账号拥有全库权限，一个 SQL 注入就能拖库。

### 账号治理清单

```
□ 所有账号有明确归属人（无"公共账号"）
□ 无 UID 0 的非 root 账号
□ 无空密码账号
□ SSH 禁 root + 禁密码
□ sudo 按命令授权 + 审计日志
□ 堡垒机统一入口 + MFA
□ 密钥有轮换计划
□ CI 有 secret 扫描
□ 90 天未登录账号已禁用
□ 应用账号权限按最小必要
```

### 一个落地顺序（小团队版）

```
第 1 步：清 root 直连 + 禁密码登录（1 天，收益最大）
第 2 步：CI 加 secret 扫描（半天）
第 3 步：应用账号权限收敛（1 天）
第 4 步：堡垒机 + MFA（1 周，需要采购/部署）
第 5 步：定期审计（每月一次，30 分钟）
```

### 本章要点

```
① 最小权限要落到"具体命令/具体库表"，不是口号
② sudo 要有 input/output 审计
③ MFA 优先放在运维入口与云控制台
④ 密钥必须能扫、能换、分用途
⑤ 僵尸账号先禁用再观察，不要直接删
```
