---
title: 第 5 章 · 应急响应：前 60 分钟做什么
module: 进阶篇
summary: 从"确认不是误报"到"隔离、取证、清理、恢复"，给出可以照着执行的六步流程与三个常见误操作。
minutes: 20
---

### 前 60 分钟的六步

```
00–05  确认并上报（不是你以为，而是证据）
05–15  隔离（断外联，但保留内网取证通道）
15–30  取证（内存、进程、网络、日志）
30–45  清理（杀进程、清持久化）
45–60  恢复与验证（重装或回滚，确认干净）
```

**顺序不能反**：先隔离再取证，先取证再清理。

### ① 确认

三个判据同时成立才算"真的被入侵"：

```
① 有异常进程或网络连接（不是"看起来可疑"）
② 有持久化痕迹（crontab、服务、SSH key）
③ 有时间线（可疑从何时开始）
```

```bash
ps -eo pid,ppid,user,etime,cmd --sort=-%cpu | head -20
ss -tunap
ls -l /proc/<pid>/exe          # 指向 /tmp 或已删除 → 强信号
```

### ② 隔离

```
① 网络层：封掉出向（只保留你的管理通道）
② 不要直接关机（内存里有证据）
③ 如果要关机，先做内存镜像（有工具时）
④ 标记主机：其他同事不要再登录（避免破坏现场）
```

**最常犯的错误**：直接 `reboot` 或 `init 0`。重启会清掉内存里的进程、临时文件、未刷盘的日志。

### ③ 取证（四项，按优先级）

```bash
# 1. 进程与网络快照
ps -ef > /evidence/ps.txt
ss -tunap > /evidence/ss.txt
lsof -i > /evidence/lsof.txt 2>/dev/null

# 2. 关键目录与文件时间线
find /tmp /var/tmp /dev/shm -type f -newer /etc/hostname -ls > /evidence/tmpfiles.txt

# 3. 持久化位置
crontab -l > /evidence/crontab.txt
ls -la /etc/cron* > /evidence/cron2.txt
systemctl list-units --type=service --state=running > /evidence/services.txt
cat /etc/ld.so.preload > /evidence/preload.txt
cat ~/.ssh/authorized_keys > /evidence/keys.txt

# 4. 日志（先拷贝，再分析）
cp /var/log/auth.log* /var/log/secure* /evidence/ 2>/dev/null
```

**证据要存到机器外**（另一台机器或对象存储），因为攻击者可能还在。

### ④ 清理

**顺序：先断持久化，再杀进程**（反了会被拉起）。

```bash
# 1. 计划任务
crontab -r
# 检查 /etc/cron.d, /etc/cron.daily 等目录里的可疑文件

# 2. 可疑服务
systemctl disable --now suspicious.service
rm -f /etc/systemd/system/suspicious.service

# 3. 动态库劫持
# 编辑 /etc/ld.so.preload，删掉可疑行；文件为空就删掉整个文件

# 4. SSH key
# 清理 authorized_keys 里不认识的条目

# 5. 进程
kill -9 <pid>
# 检查是否还有残留的守护（用 ps 对比父进程树）
```

**清理不是终点**：如果拿到了 root，**最可靠的做法是重装**。

### ⑤ 恢复与验证

```
① 判断是否需要重装（拿到 root → 建议重装）
② 从可信备份恢复数据（注意：备份可能也被感染）
③ 重装后先做加固（加固清单见本课程第 3 章）
④ 验证：跑一遍检测规则，确认无异常
⑤ 观察 24 小时（看是否有回连）
```

### 三个常见误操作

| 误操作 | 后果 |
| --- | --- |
| 直接重启/关机 | 内存证据丢失，攻击者可能只是暂时隐藏 |
| 先删文件再查 | 不知道攻击者做了什么，也无法确认是否清干净 |
| 在生产机上"边查边清理" | 破坏现场，且可能触发攻击者的破坏逻辑 |

**正确心态**：宁可多花 30 分钟取证，也不要"赶紧弄好"。

### 沟通与上报

```
① 第一时间告知负责人（不要自己扛）
② 涉及数据泄露 → 法务/合规要同步（可能有上报时限）
③ 对外口径统一（不要各自回复客户）
④ 保留沟通记录（后续复盘与追责依据）
```

### 本章要点

```
① 六步顺序：确认 → 隔离 → 取证 → 清理 → 恢复 → 验证
② 不重启、不先删、不在生产上边查边清
③ 证据要存机器外
④ 拿到 root 优先重装，不迷恋"清理干净"
⑤ 数据泄露要同步合规，注意上报时限
```
