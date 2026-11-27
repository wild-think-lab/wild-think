---
title: 跳板机与操作审计：让"谁在什么时候做了什么"可查
description: 跳板机的三种形态、堡垒机该管什么、SSH 会话录像的三种做法、命令审计的边界，以及不要做成"人肉审批"的坑。
date: 2022-06-18
tags: [跳板机, 堡垒机, 审计, 安全, 运维]
---

### 为什么要有跳板机

三个理由：

1. **收敛入口**：几十台服务器只暴露一个入口，攻击面从 50 个变成 1 个。
2. **统一身份**：所有操作都经过同一处，账号可以统一认证与回收。
3. **可审计**：谁在什么时候对哪台机器做了什么，都有记录。

没有跳板机时，最常见的场景是：**离职三个月的同事，SSH key 还在某台机器上。**

### 三种形态

| 形态 | 做法 | 适合 |
| --- | --- | --- |
| 简单跳板 | 一台机器，只装 sshd，用户先登它再跳 | 小团队（5–20 人） |
| 堡垒机（开源） | JumpServer、Teleport | 中型，需要录像与审批 |
| 云堡垒机 | 云厂商提供 | 已有云环境，想省运维 |

**别把跳板机做成"审批机器"**：每个操作都要审批，工程师会绕过它。审批只该用在"高危操作"（删库、改防火墙、上生产改配置）。

### 简单跳板的正确做法

```bash
# 客户端 ~/.ssh/config
Host bastion
    HostName 203.0.113.10
    User ops
    IdentityFile ~/.ssh/id_ed25519

# 通过跳板连内网机器（不需要在跳板上开 shell）
Host web01
    HostName 10.0.0.11
    User ops
    ProxyJump bastion
```

关键点：**跳板机只做 TCP 转发，不做交互式 shell**（`ProxyJump` 就是这种模式）。这样跳板机本身不需要装一堆工具，也不成为攻击者的落脚点。

服务端禁止转发，但允许跳转：

```ini
# /etc/ssh/sshd_config
PermitRootLogin no
AllowTcpForwarding yes
PermitTunnel no
AllowAgentForwarding no
X11Forwarding no
```

`AllowTcpForwarding yes` + `PermitTunnel no`：允许 TCP 转发（ProxyJump 需要），不允许 VPN 式隧道。

### 内网只信任跳板机

网络层：

```bash
# 内网机器只接受来自跳板机网段的 SSH
iptables -A INPUT -p tcp --dport 22 -s 10.0.0.0/24 -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -j DROP
```

或者用云安全组：22 端口只允许跳板机所在的安全组访问。

这一条比任何软件都有效——**入口收敛到网络层**，绕过跳板机就进不来。

### SSH 会话录像：三种做法

**① 简单版：`script` 记录**

```bash
# 强制登录后进 script
cat >> ~/.bashrc <<'EOF'
if [[ $- == *i* && -z "$RECORDED" ]]; then
  export RECORDED=1
  exec script -q -a "/var/log/session/$(whoami)-$(date +%s).log"
fi
EOF
```

缺点：用户能 `unset RECORDED` 绕过，且只记录输入输出，不记录时间轴。

**② 中等版：Teleport / JumpServer 自带的录像**

它们用 PTY 代理捕获所有字节流，生成可回放的 asciinema 格式。这是最实用的方案。

**③ 严格版：审计代理 + 命令白名单**

所有命令先过一层 wrapper，只允许白名单内的命令，其余拒绝。代价是维护成本高，工程师体验差。

大多数团队用 ②，配合"高危命令告警"（`rm -rf /`、`DROP DATABASE`、改 iptables）就够。

### 命令审计能做到什么、做不到什么

**能**：

- 记录谁执行了什么命令（`auditd` 或 shell 历史集中收集）。
- 记录文件修改（`auditd` 监控 `/etc/passwd`、`/etc/sudoers`）。
- 记录提权（`sudo` 日志、`journalctl -u sudo`）。

**不能**：

- 阻止有 root 的人清除痕迹（`history -c`、改日志）。
- 记录通过脚本/二进制执行的操作内容。

所以审计的前提是**日志实时外发**：本机日志可以被删，外发到中心日志平台的删不掉。

```bash
# auditd 监控关键文件
cat > /etc/audit/rules.d/critical.rules <<'EOF'
-w /etc/passwd -p wa -k identity
-w /etc/sudoers -p wa -k privilege
-w /etc/ssh/sshd_config -p wa -k sshd
-a always,exit -F arch=b64 -S execve -k exec
EOF
augenrules --load
```

`-S execve` 会记录所有命令执行，日志量很大，要配合外发与保留策略。

### 账号管理：别让"人走号还在"

跳板机的最实在价值在这儿：

```
入职 → 在跳板机加账号 + 授角色
离职 → 在跳板机删账号（一处生效，全部机器失效）
```

配合"内网只接受跳板机来源"的网络策略，删账号等于彻底断掉访问。

如果用的是"每台机器各自加账号"，离职清理就变成 50 台机器的排查任务，一定会有漏。

### 三个容易做歪的地方

1. **跳板机自己变成单点**：一跳板挂了全公司进不去。至少两台 + 前面一个 LB。
2. **跳板机权限过大**：有人在跳板机上存了所有机器的 root 私钥，等于把所有机器的钥匙放在一处。用 `ProxyJump` 模式就没有这个问题。
3. **审计只存本地**：攻击者第一件事就是清日志。**必须实时外发**。

### 一句话总结

跳板机的价值 = **入口收敛 + 统一身份 + 操作留痕**。做到"网络层只允许跳板机进、账号只在一处管、日志实时外发"，就已经覆盖 80% 的收益。
