---
title: 包管理内幕：为什么 "apt install" 会卡住
description: 依赖解析的真实过程、锁文件与"另一进程占用"、源镜像的选择、离线安装的三种做法，以及升级时的五个坑。
date: 2026-11-27
tags: [Linux, 包管理, apt, yum]
---

### 一次 `apt install` 做了什么

```
① 读 /etc/apt/sources.list 与 sources.list.d/*
② 下载索引（Packages.gz），除非你很久没 update
③ 依赖求解（SAT 求解器：找一组满足所有约束的版本）
④ 下载 .deb
⑤ 解包 + 执行 preinst/postinst 脚本
⑥ 更新 dpkg 数据库
```

**卡住通常发生在 ②（网络）或 ③（依赖冲突）**。

### 两个包管理器对照

| 动作 | Debian/Ubuntu | RHEL/CentOS |
| --- | --- | --- |
| 刷新索引 | `apt update` | `dnf makecache` |
| 装 | `apt install pkg` | `dnf install pkg` |
| 删 | `apt remove pkg`（保留配置） | `dnf remove pkg` |
| 彻底删 | `apt purge pkg` | `dnf remove pkg` |
| 升级全部 | `apt upgrade` / `full-upgrade` | `dnf update` |
| 查文件属于哪个包 | `dpkg -S /path` | `rpm -qf /path` |
| 查已装包 | `dpkg -l` | `rpm -qa` |
| 看包内容 | `dpkg -L pkg` | `rpm -ql pkg` |
| 本地安装 | `dpkg -i x.deb`（不装依赖） | `rpm -ivh x.rpm` |
| 修依赖 | `apt -f install` | `dnf install ./x.rpm`（自动解依赖） |

**`apt upgrade` vs `full-upgrade`**：后者允许"为升级而删除一些包"，风险更高。

### "锁被占用"

```
E: Could not get lock /var/lib/dpkg/lock-frontend
```

原因：另一个 apt/dpkg 进程在跑（或上次被 kill 留下锁）。

```bash
# 1. 先确认有没有真的在跑
ps aux | grep -E 'apt|dpkg'

# 2. 确实没有进程了，才清锁
rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock
dpkg --configure -a
```

**不要一看到报错就删锁**：真的有进程在跑时删锁会导致包管理器状态损坏。

### 源的选择（国内环境的关键）

```ini
# /etc/apt/sources.list（Ubuntu 22.04 示例）
deb https://mirrors.aliyun.com/ubuntu/ jammy main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ jammy-updates main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ jammy-security main restricted universe multiverse
```

CentOS 7（EOL 后需要换镜像源）：

```ini
# /etc/yum.repos.d/CentOS-Base.repo
[base]
name=CentOS-7 - Base
baseurl=https://mirrors.aliyun.com/centos-vault/7.9.2009/os/$basearch/
gpgcheck=0
enabled=1
```

**CentOS 7 已 EOL**：官方源失效，必须换 `centos-vault` 或迁移。这是大量老系统当前的现实问题。

### 优先用"就近 + 可信"的源

```
① 官方源（最可信，但慢）
② 国内镜像（快，内容一致）
③ 私有仓（Nexus/Artifactory，团队内统一版本）
④ 第三方源（PPA/EPEL）—— 谨慎，会引入兼容风险
```

**私有仓的价值**：CI 不依赖外网、版本可控、可离线。

### 离线安装的三种做法

**① 下载 deb/rpm 及其依赖**

```bash
# Debian：用 apt-rdepends 或直接下载
apt-get install --download-only pkg
ls /var/cache/apt/archives/*.deb

# 更彻底（含依赖树）
apt-get install --reinstall --download-only $(apt-rdepends pkg | grep -v '^  ')
```

**② 用 yumdownloader（RHEL 系）**

```bash
yumdownloader --resolve --destdir /tmp/pkgs nginx
```

**③ 整机制同版本 + rsync 缓存目录**

```
把 /var/cache/apt/archives 或 /var/cache/dnf 拷到目标机
```

### 升级时的五个坑

**① 配置文件冲突**

```
Configuration file '/etc/nginx/nginx.conf'
 ==> Modified (by you or by a script) since installation.
```

处理原则：**先 diff，再决定**。

```bash
# 看差异
apt install -o Dpkg::Options::="--force-confold" pkg    # 保留旧配置
# 或 --force-confnew 用新配置
```

**② 内核升级后没重启**

```bash
# 检查是否需要重启
[ -f /var/run/reboot-required ] && cat /var/run/reboot-required
```

**③ 自动清理把依赖删了**

```bash
apt autoremove        # 谨慎：可能删掉你手工装的依赖
# 先看会删什么
apt autoremove --dry-run
```

**④ 升级中断（断电/被杀）**

```bash
dpkg --configure -a
apt -f install
```

**⑤ 部分升级导致系统半新半旧**

```bash
# apt 报 "held back" 的包
apt list --upgradable
apt-mark showhold
```

**安全原则**：生产机升级前**先在预发跑一遍**，并留快照/备份。

### 版本锁定（重要的运维手段）

```bash
# Debian：禁止某包升级
apt-mark hold nginx
apt-mark showhold
apt-mark unhold nginx

# RHEL
dnf versionlock add nginx
```

**什么时候锁版本**：

```
① 依赖特定版本的应用（如老版本 PHP）
② 升级会破坏兼容性的组件（如数据库客户端库）
③ 待验证的新版本（先锁住，验证后再解）
```

### 检查清单

```
□ 源用就近镜像（国内环境）
□ 私有仓存团队关键包
□ 升级前预发验证 + 快照
□ 配置文件冲突先 diff
□ 内核升级后检查是否需要重启
□ autoremove 先 --dry-run
□ 关键包锁版本
□ 有离线安装包备份（应对断网/源失效）
```
