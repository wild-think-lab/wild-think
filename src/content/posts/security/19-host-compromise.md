---
title: 主机入侵排查：一台机器"看起来正常但 CPU 一直 100%"
description: 从挖矿木马到隐藏进程，八类常见入侵痕迹、逐层排查命令，以及"被替换的命令"怎么识别。
date: 2025-04-16
tags: [安全, 入侵排查, Linux]
---

### 典型开场

```
现象：某台云主机 CPU 持续 100%，但 top 里看不到明显的高占用进程
或者：top 里有个叫 "kdevtmpfsi" / "xmrig" / "[kworker]" 的进程
```

**"[xxx]" 带方括号但能在 top 里看到，往往是伪装成内核线程的恶意进程**。

### 排查顺序（逐层）

```
① 进程层（谁在跑）
② 网络层（连到哪）
③ 文件层（从哪来、改了什么）
④ 启动层（怎么每次重启都活）
⑤ 账号层（谁进来的）
⑥ 内核层（是否被 rootkit 挂钩）
```

### ① 进程层

```bash
# 按 CPU 排序（top 的默认视图可能被篡改，用 ps 交叉验证）
ps -eo pid,ppid,user,pcpu,pmem,etime,cmd --sort=-pcpu | head -20

# 进程树（看父进程）
ps -ef --forest | head -60

# 名字可疑的
ps -ef | grep -E "kdevtmpfsi|xmrig|minerd|kinsing|ddgs|sysupdate" 

# 从 /proc 直接看（绕过 ps 可能被替换）
for p in /proc/[0-9]*; do
  echo "$(basename $p) $(cat $p/comm 2>/dev/null) $(readlink $p/exe 2>/dev/null)"
done | grep -v "kernel"
```

**关键判据**：

```
① 可执行文件在 /tmp、/dev/shm、/var/tmp → 高度可疑
② 进程名像内核线程但 exe 指向普通文件 → 伪装
③ 父进程已死（PPID=1）但进程还活着 → 被 reparent 的孤儿
④ 命令带长串 base64/十六进制 → 混淆
```

**"可执行文件被删除但进程还在跑"**：

```bash
ls -l /proc/<pid>/exe
# 输出 "-> /tmp/xxx (deleted)" → 恶意进程删了自己的文件
# 可以恢复：
cp /proc/<pid>/exe /evidence/recovered_bin
```

**这个技巧非常实用**：攻击者常删掉文件但进程还在跑。

### ② 网络层

```bash
ss -antp | grep ESTAB
# 或
netstat -antp | grep ESTAB

# 看 DNS 查询（C2 常走 DNS）
ss -u -a | head -20

# 可疑端口监听
ss -lntp
```

**判据**：

```
① 连到陌生公网 IP 的 3333/4444/5555/8080/8443 → 常见 C2/矿池端口
② 进程名与端口用途不符
③ 大量对外连接（扫描/爆破其他主机）
```

**查 IP 归属**：

```bash
whois <ip>
# 或 curl ipinfo.io/<ip>
```

**矿池特征**：

```
常见端口：3333、4444、5555、7777、9999
常见域名：pool.minexmr.com、xmrpool.eu
```

### ③ 文件层

```bash
# 最近 7 天被修改的文件（排除日志）
find / -xdev -type f -newermt '-7 days' \
  -not -path '/var/log/*' -not -path '/proc/*' -not -path '/sys/*' \
  2>/dev/null | head -50

# 可疑目录里的可执行文件
find /tmp /dev/shm /var/tmp /run -type f -executable 2>/dev/null

# 隐藏文件
find / -name ".*" -type f -newermt '-7 days' 2>/dev/null | head

# 不可变属性（攻击者常给文件加 +i 防删）
lsattr -R /usr/bin 2>/dev/null | grep -E "^\S+\s+i"
```

**"chattr +i" 是恶意软件的常见手法**：文件加了不可变属性，`rm` 会报 Operation not permitted。

**去掉**：

```bash
chattr -i /path/to/file && rm -f /path/to/file
```

**校验关键命令是否被替换**：

```bash
# 用 rpm/dpkg 校验包完整性
rpm -Va | grep -E "^..5"          # RHEL 系
debsums -c                        # Debian 系

# 或与已知好包比对
rpm -qf /usr/bin/ps
```

**"ps 被替换"的识别**：

```
① ps 输出的进程数 < /proc 里数字目录数
② ps 看不到某个明显的进程
③ 文件大小/修改时间异常
```

**最可靠的办法**：**用静态编译的 busybox 或从干净机器拷一份工具来排查**。

```bash
# 用干净的工具
/opt/clean/busybox ps
/opt/clean/busybox netstat -antp
```

### ④ 启动层（持久化）

```bash
# cron
crontab -l
ls -la /etc/cron.d /etc/cron.hourly /etc/cron.daily
cat /etc/crontab

# systemd
systemctl list-units --type=service --state=running
ls -la /etc/systemd/system/
grep -r "ExecStart" /etc/systemd/system/*.service

# rc.local / init
cat /etc/rc.local 2>/dev/null

# 用户级
ls -la ~/.config/autostart 2>/dev/null

# SSH 后门
cat ~/.ssh/authorized_keys
grep -r "command=" /root/.ssh/ 2>/dev/null
```

**最隐蔽的持久化**：

```
① systemd 的 timer（不只 service）
② ld.so.preload（劫持所有动态链接）
③ PAM 模块（登录时执行）
④ /etc/profile.d/ 下的脚本（登录即执行）
```

```bash
# 检查 ld.so.preload（这是 rootkit 的经典手法）
cat /etc/ld.so.preload

# 检查 PAM
ls -la /lib*/security/ | head
grep -r "pam_exec" /etc/pam.d/
```

**`/etc/ld.so.preload` 里有东西 → 几乎可以确定被挂钩了**。

### ⑤ 账号层

```bash
# UID 为 0 的非 root 账号
awk -F: '$3==0 {print}' /etc/passwd

# 有 shell 的账号
awk -F: '$7 !~ /nologin|false/ {print $1, $7}' /etc/passwd

# 空密码账号
awk -F: '$2=="" {print $1}' /etc/shadow

# sudo 权限
cat /etc/sudoers
ls -la /etc/sudoers.d/

# 最近登录
last -a | head -20
lastb -a | head -20
```

**"新增的 UID 0 账号"是最常见的后门**：

```bash
# 例：root2:x:0:0:...
usermod -L root2      # 先锁
# 再评估是否删除（保留证据先记录）
```

### ⑥ 内核层

```bash
# 内核模块
lsmod
cat /proc/modules

# 可疑模块（名字古怪、无签名）
modinfo <module> | grep -E "filename|description"

# 内核完整性（如启用）
dmesg | grep -i "taint"
```

**内核级 rootkit 的迹象**：

```
① lsmod 里有陌生模块
② /proc/kallsyms 里符号被改
③ 系统调用表被 hook（普通手段看不到）
```

**结论**：**内核级被控 → 直接重建**，不要尝试清理。

### 一个完整处置流程

```bash
# 1. 隔离（不关机）
#    云安全组里封掉该主机的出入流量，只留运维通道

# 2. 采集
mkdir -p /evidence && cd /evidence
ps -ef > ps.txt; ss -antp > ss.txt; lsmod > lsmod.txt
cp /proc/<pid>/exe ./evil.bin
sha256sum evil.bin > sha.txt

# 3. 确认持久化点
crontab -l > cron.txt
ls -la /etc/systemd/system/ > units.txt
cat /etc/ld.so.preload > ldpreload.txt

# 4. 阻断（先停服务，避免反复拉起）
systemctl stop <evil>.service
# 或 mask（防被其他服务拉起）
systemctl mask <evil>.service

# 5. 清除
chattr -i <files>
rm -f <files>

# 6. 轮换
#    SSH key、数据库密码、云 AK/SK、CI token 全部换

# 7. 重建（推荐）
#    从可信快照/镜像重建，迁移业务数据
```

### 五个"排查时容易漏"的点

```
① 只查了 CPU 高，没查"网络外联"（挖矿常伴随 C2）
② 只查了 root，没查普通账号（攻击者常用低权限账号潜伏）
③ 只查了当前机器，没查横向（同网段其他机器）
④ 只删了文件，没停服务（被 systemd 立刻拉起）
⑤ 只清了恶意进程，没查"怎么进来的"（会再被进一次）
```

### 检查清单

```
□ 用干净工具排查（防 ps/netstat 被替换）
□ 检查 /tmp /dev/shm 下的可执行文件
□ 检查 (deleted) 的进程可执行文件并恢复
□ 统计 ESTAB 连接与可疑端口
□ 检查 cron / systemd / rc.local / profile.d
□ 检查 /etc/ld.so.preload（重点！）
□ 检查 UID=0 账号与 authorized_keys
□ 检查 lsmod 有无陌生模块
□ 检查关键命令完整性（rpm -Va / debsums）
□ 停服务 + mask（防拉起）再清除
□ 轮换所有密钥
□ 排查同网段横向
□ 结论：内核级被控 → 重建
```
