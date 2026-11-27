---
title: 应急响应六阶段：从判据到复盘的完整动作链
description: 出了安全事件，最怕的是"边猜边操作"。按准备—检测—抑制—根除—恢复—复盘六阶段推进，每一步都有明确的输入、输出与判断依据。
date: 2026-10-08
tags: [安全, 应急响应, 取证, 入侵排查, 等保]
---

应急响应的目标不是"把服务赶紧拉起来"，而是**在控制损失的前提下，把事实固定下来**。顺序颠倒，证据就没了。

## 一、准备（Prepare）

平时就该有的东西，事发时才想不起来就晚了：

- 资产清单（IP、归属业务、负责人）与网络拓扑
- 账号权限矩阵、跳板机与日志集中平台
- 离线取证工具包（`dd`、`memdump`、`tcpdump`、`auditd` 规则集、哈希校验工具）
- 联系链（业务、法务、云厂商、监管报送口径）
- 已知的应急剧本：Web 入侵、挖矿、勒索、数据外泄

## 二、检测与确认（Detect）

先回答三个问题：**什么时间、影响范围、是否仍在活动**。

### 主机侧快速判据

```bash
# 1) 异常进程与资源占用
ps auxf --sort=-%cpu | head -20
ps auxf --sort=-%mem | head -15

# 2) 网络连接：外联可疑 IP、监听异常端口
ss -antp | grep ESTAB
ss -lntup

# 3) 持久化点（攻击者最爱）
crontab -l; ls -l /etc/cron.* /var/spool/cron/*
systemctl list-units --type=service --state=running
ls -l /etc/rc.local /etc/profile.d/
cat /etc/ld.so.preload            # 空文件才对，有内容高度可疑

# 4) 账号侧
last -a | head -30
lastb | head -20                  # 爆破痕迹
awk -F: '$3==0{print $1}' /etc/passwd
grep -E "sshd|sudo" /var/log/secure | tail -50

# 5) 文件完整性
rpm -Va --nofiles --nodigest 2>/dev/null | head -50   # RHEL 系
debsums -c 2>/dev/null                                # Debian 系
```

### 判据组合比单点更重要

- 一个"高 CPU 进程"可能是业务问题；**高 CPU + 外联陌生 IP + `ld.so.preload` 非空**才是强信号。
- `sshd` 有大量失败登录但无成功登录，说明在爆破；**有成功登录且来源 IP 陌生**才是入侵。

### 检出前的第一动作

**不要**急着 `kill`、`reboot`、`rm`。先做：

1. 时间线对齐：`date`、`timedatectl`，确认主机与日志平台时间一致。
2. 抓取易失数据：内存中进程、网络连接、登录会话（进程一重启就没了）。
3. 记录现场：截图/命令输出存证，写明执行时间与执行人。

```bash
# 易失数据快照（示例）
{ date; hostname; uptime; } > /evidence/00-context.txt
ss -antp > /evidence/01-connections.txt
ps auxf > /evidence/02-processes.txt
sha256sum /evidence/*.txt
```

## 三、抑制（Contain）

目标是**切断攻击者通路，同时保住业务**。常用手段按"影响从大到小"排序：

| 手段 | 适用 | 风险 |
| --- | --- | --- |
| 出口/入口防火墙封禁恶意 IP | 已确定单点来源 | 可能误封 CDN/代理 IP |
| 隔离主机（下线网线/移出安全组） | 主机已失守 | 业务立即中断 |
| 停用被盗账号、重置凭据 | 账号泄露 | 影响合法用户 |
| 关闭被利用的服务/端口 | 漏洞正在被利用 | 影响依赖方 |

关键动作：**封禁前先留存证据**，否则后续溯源无据。封禁范围记录进时间线，便于复盘时判断"是否抑制到位"。

## 四、根除（Eradicate）

抑制只挡住通路，恶意代码可能还在。根除要做的是：

1. 定位入口：Web 日志、WAF 记录、文件上传目录、暴露的弱口令服务。
2. 清除持久化：cron、systemd unit、`~/.ssh/authorized_keys`、`/etc/ld.so.preload`、Web 目录下的 webshell。
3. 修补入口：打补丁、改配置、关闭暴露面。
4. 重置所有可能泄露的凭据（数据库、API Key、SSH 密钥、云账号 AK/SK）。

**重建 vs 清理的选择**：如果主机已确认被 root 级控制、或存在内核级 rootkit，最稳妥的做法是**重装/重建**，只迁移业务数据（并校验数据未被篡改）。清理"看起来干净了"的机器是最常见的返工来源。

## 五、恢复（Recover）

- 分批恢复，先灰度一台，观察 24 小时。
- 恢复后立刻验证：服务功能、日志上报、备份任务、监控告警都正常。
- 加强监控窗口期：把近期异常行为（同一来源、相同路径、相似 UA）作为临时告警规则。

## 六、复盘（Review）

复盘不是写检查，是产出可执行改进项。模板：

| 项 | 内容 |
| --- | --- |
| 时间线 | 首次入侵、发现、抑制、根除、恢复各时间点 |
| 入口 | 具体漏洞/弱口令/配置 |
| 影响 | 数据、主机、时长、业务损失 |
| 有效动作 | 哪些判断与处置起了作用 |
| 失效动作 | 哪些监控没告警、哪些备份不可用 |
| 改进项 | 每条都要有负责人与截止时间 |

## 附：常用命令速查（防守侧）

```bash
# 找最近被修改的 Web 文件（webshell 常藏在这里）
find /var/www -type f -mtime -3 -name "*.php" -o -name "*.jsp" | head -40

# 找可疑可执行文件
find /tmp /dev/shm /var/tmp -type f -perm -111 -mtime -7 2>/dev/null

# 检查 SSH 授权公钥（后门常用）
grep -r "" /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null

# 检查异常 SUID
find / -xdev -perm -4000 -newermt "-7 days" -type f 2>/dev/null
```

> 底线两条：**先取证再操作；先抑制泄露再恢复业务**。顺序反了，事件就从"技术问题"升级成"合规问题"。
