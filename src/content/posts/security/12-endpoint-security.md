---
title: 终端安全：从"装杀毒"到"能看见异常进程"
description: 端点安全的四层防护、白名单与 EDR 的差异、常见持久化手法怎么发现、以及一次挖矿事件的完整处置。
date: 2026-11-27
tags: [安全, 端点, EDR, 应急]
---

### 四层防护

```
① 预防：补丁、最小权限、关闭不必要服务
② 检测：EDR/HIDS、进程与网络行为、文件完整性
③ 响应：隔离主机、杀进程、清持久化
④ 恢复：重装/回滚、复测、复盘
```

**只做①的结果是"永远在事后发现"**。

### 白名单 vs 黑名单

| | 黑名单（传统杀毒） | 白名单（应用控制） |
| --- | --- | --- |
| 逻辑 | 已知恶意才拦 | 只允许已知程序 |
| 未知恶意 | **放过** | 拦住 |
| 维护成本 | 低 | 高（新软件要审批） |
| 适用 | 通用办公 | 服务器、固定用途终端 |

服务器上更推荐白名单（只允许已知的二进制执行），但要留运维通道（否则自己也被拦）。

### 常见持久化手法（重点看这几处）

**Linux**：

```bash
# cron
crontab -l; cat /etc/crontab; ls /etc/cron.*
# systemd
systemctl list-units --type=service --state=running
ls -lt /etc/systemd/system/*.service | head
# 启动脚本
cat /etc/rc.local
# SSH 公钥
cat ~/.ssh/authorized_keys
# 动态库劫持
cat /etc/ld.so.preload
# 用户
awk -F: '$3==0{print}' /etc/passwd      # UID 0 的账号
```

**Windows**：

```powershell
Get-ScheduledTask | Where-Object State -eq Ready | Select TaskName, TaskPath
Get-CimInstance Win32_StartupCommand
reg query HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run
Get-LocalUser | Where-Object Enabled -eq $true
```

**六个"必看"位置**：计划任务、启动项、服务、SSH 公钥、`ld.so.preload`、UID 0 账号。

### 发现异常进程的四个信号

```
① 路径可疑：/tmp、/dev/shm、/var/tmp 下运行的二进制
② 无父进程或父进程异常（ppid=1 但不在 systemd 里）
③ 网络连接异常：连陌生 IP、连矿池端口（3333/5555/14444）
④ CPU 持续高但业务不需要
```

排查：

```bash
# 进程与网络
ps -eo pid,ppid,user,etime,cmd --sort=-%cpu | head -20
ss -tunap | grep -v '127.0.0.1'
# 可执行文件是否被删除（常见于内存马）
ls -l /proc/<pid>/exe
# 打开的文件
lsof -p <pid>
```

Windows：

```powershell
Get-Process | Sort-Object CPU -Descending | Select -First 10 Name,Id,CPU,Path
Get-NetTCPConnection -State Established | Select RemoteAddress,RemotePort,OwningProcess
```

### 一次挖矿事件处置实录

**现象**：某台机器 CPU 长期 100%，业务变慢。

**① 定位**

```bash
top -o %CPU        # 进程名 kdevtmpfsi（伪装成内核线程）
ls -l /proc/<pid>/exe   # 指向 /tmp/.x/ 下的文件（已删除状态）
ss -tunap | grep <pid>  # 连向 xxx:3333
crontab -l              # 有一条 */10 * * * * 的下载脚本
```

**② 隔离**

```
- 网络层封掉该主机出向（避免继续挖矿/被控）
- 保留现场（不要立即重启，先取证）
```

**③ 清理**

```bash
# 先停持久化，再杀进程（顺序反了会被拉起）
crontab -r
systemctl disable --now <可疑服务>
kill -9 <pid>
rm -f /tmp/.x/* /etc/ld.so.preload 里的对应行
```

**④ 验证**

```
- 观察 30 分钟，确认无新进程拉起
- 检查所有账号的 authorized_keys
- 检查是否有其他机器被同一 IP 登录（日志）
```

**⑤ 根因**

日志显示：Redis 未设密码 + 绑定 0.0.0.0 → 攻击者写入 SSH 公钥 → 登录 → 部署挖矿。

**⑥ 改进**

```
- Redis 加密码 + 只监听内网 + 禁用危险命令
- 禁止 root 直接 SSH 登录
- 加"未知出向连接"告警
```

### EDR 能做什么（以及不能做什么）

能做：

- 记录进程树、命令行、网络连接（可回溯）
- 拦截已知恶意行为（如 `powershell -enc` 下载执行）
- 一键隔离主机
- 文件完整性监控

不能做：

- 拦住"正常工具被滥用"（比如用 `certutil` 下载文件，本身是合法程序）
- 替代补丁管理（漏洞还是要在前面修）

### 服务器加固的三条硬规则

```
① 不用密码登录，只用密钥（且密钥有 passphrase）
② 出向默认白名单（只允许必要的目标）
③ 所有提权操作有审计日志（sudo 全记录）
```

第②条最有效：**即使被打进来，也连不出去**。

### 检查清单

```
□ 补丁有节奏（每月至少一次）
□ 有 EDR 或 HIDS（能看进程树与网络）
□ 定期检查六处持久化位置
□ 有"未知出向连接"告警
□ 服务器禁用密码登录
□ 有应急流程：隔离 → 取证 → 清理 → 验证 → 复盘
```
