---
title: Linux 日志体系：journald 与 rsyslog 到底谁在写日志
description: 搞清楚 journald、rsyslog 的分工与数据流，才能在两套日志之间快速定位故障，而不是把 /var/log 翻一遍碰运气。
date: 2026-11-24
tags: [Linux, journald, rsyslog, 日志, 排障]
---

很多人在服务器上排障的第一反应是 `cat /var/log/messages`，然后发现"没有这条日志"，就判定"服务没报错"。实际上日志系统是两条并行链路，你看到的那份可能根本不是服务真实输出的那一份。

## 一、两条链路的分工

systemd 体系下，日志的起点都是同一个：**进程把消息写到 stdout/stderr 或 syslog socket**。之后分成两支。

| 链路 | 收集者 | 存储位置 | 特点 |
| --- | --- | --- | --- |
| systemd 链路 | `systemd-journald` | `/run/log/journal`（内存）或 `/var/log/journal`（持久） | 二进制、结构化字段、带优先级与单元信息 |
| syslog 链路 | `rsyslog` / `syslog-ng` | `/var/log/messages`、`/var/log/secure` 等文本 | 纯文本、规则灵活、可转发到远端 |

关键点：**journald 会把日志转发给 rsyslog**（通过 `/run/systemd/journal/syslog` socket），所以早先的文本日志常常是 journald 的"副本"。但方向不是反的——rsyslog 收到的日志不会再回流到 journald。

这解释了两种常见现象：

- 服务用 `systemd` 托管、直接打印到 stdout 时，日志只在 journald 里；如果 rsyslog 没配置对应规则，`/var/log/messages` 里就看不到。
- rsyslog 挂了（比如磁盘满、配置写错），journalctl 依然有日志，因为 journald 不依赖 rsyslog。

## 二、journalctl 的正确打开方式

`journalctl` 的信息密度远高于 `grep /var/log/messages`，因为它按字段检索。

```bash
# 只看某个单元，并且是本次开机以来
journalctl -u nginx --since today

# 按优先级过滤（0 emerg → 7 debug），只看 err 及以上
journalctl -p err -b

# 内核环形缓冲区相关
journalctl -k --since "1 hour ago"

# 按可执行文件名过滤（程序没跑在 systemd 单元里时特别有用）
journalctl _COMM=sshd -n 100

# 结构化输出，方便喂给 jq
journalctl -u sshd -o json-pretty -n 5
```

常用字段：`_PID`、`_UID`、`_COMM`、`_EXE`、`_SYSTEMD_UNIT`、`PRIORITY`、`SYSLOG_IDENTIFIER`。排查"到底是谁在刷日志"时，`journalctl -o json | jq -r '._COMM' | sort | uniq -c | sort -rn` 比翻文本快得多。

## 三、持久化：别忘了默认可能不落盘

`/run/log/journal` 在 tmpfs 上，**重启即丢**。要保留历史，需要让目录存在并重启 journald：

```bash
sudo mkdir -p /var/log/journal
sudo systemctl restart systemd-journald
# 验证：持久化后 Storage 应为 persistent
journalctl --disk-usage
```

容量控制写在 `/etc/systemd/journald.conf`：

```ini
[Journal]
Storage=persistent
SystemMaxUse=2G
SystemKeepFree=1G
MaxRetentionSec=30day
```

`SystemMaxUse` 之外还有 `RuntimeMaxUse`（tmpfs 部分）。压测机器上曾出现过 journal 占满 `/run` 导致其他服务写临时文件失败的情况，这类问题只能靠限额避免。

## 四、rsyslog 侧的规则与转发

`/etc/rsyslog.conf` 的核心是"选择器 + 动作"：

```conf
# 认证类日志单独存一份，并且不重复写入 messages
authpriv.*                       /var/log/secure
& stop

# 把 warning 及以上的内核日志转发到日志服务器
kern.warning                     @@192.168.10.20:514
```

`@` 是 UDP，`@@` 是 TCP。集中式日志场景下建议 TCP + 磁盘缓冲，否则网络抖动会静默丢日志：

```conf
*.*  action(type="omfwd" target="log01" port="514" protocol="tcp"
       queue.type="disk" queue.size="50000" action.resumeRetryCount="-1")
```

改完配置必须做语法校验，否则重启直接失败：

```bash
sudo rsyslogd -N1
sudo systemctl restart rsyslog
```

## 五、一条实用的排障顺序

1. `systemctl status <svc>` 看退出码与最近三行（这是 journald 取的）。
2. `journalctl -u <svc> -n 80 --no-pager` 看完整上下文，注意时间戳是否连续。
3. 若进程不在 systemd 管理下，改用 `journalctl _COMM=<name>` 或 `journalctl _PID=<pid>`。
4. 需要长期证据、要给审计看，回到 `/var/log/<对应文件>`，并确认 rsyslog 规则没把它丢弃（`& stop` 会阻止后续规则）。
5. 交叉验证：`logrotate` 是否刚切过文件，`grep` 到的是旧文件还是新文件。

> **一个典型坑**：日志"消失"往往不是服务没输出，而是 journald 的 `Storage=volatile` + 重启，或 rsyslog 规则里 `& stop` 把 `authpriv` 从 `messages` 里截走了。判断依据是先看 journald 有没有，再看 rsyslog 有没有。
