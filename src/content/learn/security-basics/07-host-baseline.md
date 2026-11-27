---
title: 主机与基线安全：把默认打开的门关上
module: 熟练篇
summary: 基线清单、账号与 SSH、防火墙、文件权限、日志审计，五个"新机器上线就有的风险"。
minutes: 45
---

### 新机器的默认风险

```
① root 密码直接可登
② SSH 允许密码 + root
③ 一堆没用的服务在跑
④ 防火墙没开
⑤ 系统补丁落后
```

**"内网就没事"** 是最常见的假设，也是横向移动的起点。

### 基线清单（照做）

```bash
# 1. 更新
dnf update -y security
# 2. 关掉不用的服务
systemctl list-unit-files --state=enabled
systemctl disable --now postfix avahi-daemon cups
# 3. 防火墙
systemctl enable --now firewalld
firewall-cmd --permanent --add-service=ssh --add-service=http
firewall-cmd --reload
# 4. SSH 加固
sshd -T | grep -E 'permitrootlogin|passwordauthentication'
```

### SSH 加固（最值钱的一步）

```conf
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
ClientAliveInterval 300
AllowUsers deploy admin
```

```bash
sshd -t && systemctl reload sshd
```

**注意**：先确认自己能登录（另一会话留着），再关密码登录。

### 账号与 sudo

```bash
useradd -m -s /bin/bash deploy
usermod -aG wheel deploy        # 或 sudo 组
visudo -c
```

```conf
# /etc/sudoers.d/deploy
deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart app
```

**"给所有人 ALL 免密 sudo"** → 等于没有权限边界。

### 文件权限与敏感文件

```bash
chmod 600 /etc/shadow /root/.ssh/authorized_keys
chmod 700 /root/.ssh
find / -xdev -perm -0002 -type f 2>/dev/null | head   # 全局可写文件
```

### 审计（最小可用）

```bash
dnf install -y audit
systemctl enable --now auditd
```

```conf
# /etc/audit/rules.d/base.rules
-w /etc/passwd -p wa -k identity
-w /etc/sudoers -p wa -k privilege
-w /root/.ssh -p wa -k ssh
-a always,exit -F arch=b64 -S execve -k exec
```

```bash
augenrules --load
ausearch -k identity | tail
```

**"没有审计"** → 出事之后无法回答"谁改的"。

### 五个"上线就有的风险"

**① 密码登录开着 + 公网 IP**

```
爆破日志一天几百条，只是时间问题
```

**② root 直登**

```
一次失手就是整机
```

**③ 防火墙没开但"内网安全"**

```
一台被拿下 → 横向扫全网
```

**④ 补丁从不打**

```
已知漏洞（如 OpenSSH/glibc）长期暴露
```

**⑤ 密钥权限松**

```
authorized_keys 644 → ssh 拒绝或可被改写
```

### 检查清单

```
□ 安全补丁已打
□ 无用服务已关
□ 防火墙已开（只放行必要端口）
□ root 禁止 SSH 登录
□ 密码登录关闭（用密钥）
□ 普通账号 + 受限 sudo
□ 敏感文件权限正确
□ 无全局可写文件
□ auditd 有基础规则
□ 有登录失败与提权审计
```
