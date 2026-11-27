---
title: 实验：CentOS 7 YUM 源失效的四种修复路径
description: CentOS 7 停止维护后，默认源返回 404 或镜像站改路径，yum 全面不可用。按"镜像站替换 / 本地仓库 / 内网代理 / 离线 RPM"四条路径给出可执行脚本与验证方式。
date: 2026-11-23
tags: [CentOS7, YUM, 源修复, 运维, 实验]
---

CentOS 7 在 2024-06-30 结束维护，`mirrorlist.centos.org` 相关地址陆续失效。表现是 `yum makecache` 报 `404`、`Cannot find a valid baseurl`，或者卡在 `Determining fastest mirrors`。

关键判断：**先看报错是"域名无法解析"还是"仓库返回 404"**。前者是 DNS/网络问题，后者才是源地址失效。

```bash
curl -I http://mirror.centos.org/centos/7/os/x86_64/        # 已失效
curl -I https://vault.centos.org/7.9.2009/os/x86_64/         # 归档地址，仍可访问
```

## 路径一：换成仍提供 7 镜像的国内镜像站（推荐）

以阿里云镜像为例（其 `centos-vault` 仍提供 7 的历史版本）。备份原配置后整目录替换：

```bash
#!/bin/bash
set -e
[[ $EUID -eq 0 ]] || { echo "需要 root"; exit 1; }

mkdir -p /etc/yum.repos.d/backup
mv /etc/yum.repos.d/CentOS-*.repo /etc/yum.repos.d/backup/ 2>/dev/null || true

cat > /etc/yum.repos.d/CentOS-Base.repo <<'EOF'
[base]
name=CentOS-7 - Base - mirrors.aliyun.com
baseurl=https://mirrors.aliyun.com/centos-vault/7.9.2009/os/$basearch/
gpgcheck=1
gpgkey=https://mirrors.aliyun.com/centos-vault/RPM-GPG-KEY-CentOS-7
enabled=1

[updates]
name=CentOS-7 - Updates
baseurl=https://mirrors.aliyun.com/centos-vault/7.9.2009/updates/$basearch/
gpgcheck=1
gpgkey=https://mirrors.aliyun.com/centos-vault/RPM-GPG-KEY-CentOS-7
enabled=1

[extras]
name=CentOS-7 - Extras
baseurl=https://mirrors.aliyun.com/centos-vault/7.9.2009/extras/$basearch/
gpgcheck=1
gpgkey=https://mirrors.aliyun.com/centos-vault/RPM-GPG-KEY-CentOS-7
enabled=1

[centosplus]
name=CentOS-7 - Plus
baseurl=https://mirrors.aliyun.com/centos-vault/7.9.2009/centosplus/$basearch/
gpgcheck=1
enabled=0
EOF

# epel 也一起换（若已安装）
if rpm -q epel-release >/dev/null 2>&1; then
  sed -i 's|^metalink=|#metalink=|; s|^#baseurl=http://download.fedoraproject.org/pub/epel|baseurl=https://mirrors.aliyun.com/epel|' /etc/yum.repos.d/epel*.repo
fi

yum clean all
yum makecache fast
yum repolist
```

验证：`yum repolist` 应显示各仓库的包数量且无报错；`yum install -y tree` 能成功安装。

**注意版本号**：`7.9.2009` 是最终版本，若你的系统是 7.6，`$releasever` 会取到 7，但 vault 路径需要具体的 `7.9.2009`。用固定路径比用 `$releasever` 更可靠。

## 路径二：建立本地文件仓库（离线环境首选）

把整套 `os/`、`updates/` 包同步到本地或内网服务器，做成 `file://` 仓库。

```bash
# 在内网有网的机器上（用 reposync 或直接 wget 镜像目录）
yum install -y yum-utils createrepo
reposync -r base -p /data/mirror/centos7
reposync -r updates -p /data/mirror/centos7

# 生成元数据（每同步一次都要重跑）
createrepo --update /data/mirror/centos7/base
createrepo --update /data/mirror/centos7/updates
```

客户端配置：

```ini
[local-base]
name=Local CentOS7 Base
baseurl=file:///data/mirror/centos7/base
gpgcheck=0
enabled=1
```

`gpgcheck=0` 只在内网可信仓库使用；有条件时应导入 GPG key 并保持校验开启。

## 路径三：走内网 yum 代理

若已经有 Nexus/Artifactory 或 `squid`，让 yum 走代理最省事：

```ini
# /etc/yum.conf
[main]
proxy=http://10.0.0.20:8080
proxy_username=optional
proxy_password=optional
```

或者只对某个仓库生效：在对应 `.repo` 段里加 `proxy=`。

## 路径四：纯离线单包安装

只需要几个 rpm 时，不必修好整个源：

```bash
# 在能下载的机器上带上依赖
yumdownloader --resolve --destdir /tmp/rpms nginx
# 拷到目标机
rpm -Uvh --nodeps /tmp/rpms/*.rpm     # 慎用 --nodeps
```

`--nodeps` 是最后手段，装完 `ldd`/`systemctl start` 常因缺库直接失败。

## 常见连带故障

1. **`yum` 报 `Another app is currently holding the yum lock`**：删掉 `/var/run/yum.pid` 或 `kill` 掉占用进程，不要并行跑 yum。
2. **`Error: rpmdb open failed`**：rpm 数据库损坏，重建：`rm -f /var/lib/rpm/__db*; rpm --rebuilddb`。
3. **`GPG key retrieval failed`**：`rpm --import <key url>` 或临时 `gpgcheck=0` 排查，确认后再开回来。
4. **DNS 解析失败**：`curl -I <baseurl>` 先确认域名可达；`/etc/resolv.conf` 里 nameserver 不通时，yum 的报错也会伪装成源失效。

## 修复后的验证清单

```bash
yum clean all && yum makecache fast        # 无 404
yum repolist                               # 各仓库有包数
yum -y install tree && tree --version      # 实际安装
yum update --security --dry-run            # 安全更新可解析（不实际升级）
```

> 经验：**源失效报 404，DNS 故障报 timeout，证书问题报 SSL**。三类报错先分清，再动手改配置，能少走一半弯路。
