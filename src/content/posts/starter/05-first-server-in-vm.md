---
title: 零基础：用一台虚拟机搭出你的第一台服务器
description: 从下载 ISO 到能远程登录、能装软件、能开一个网页，全程只用免费工具，每一步都给命令和"成功的样子"。
date: 2021-12-03
tags: [入门, 虚拟机, Linux, 服务器]
---

### 你要达成的三件事

1. 在电脑上跑起一台 Linux 虚拟机（不花钱、不影响本机）。
2. 用 SSH 从自己的电脑登录进去。
3. 在里面装一个 Nginx，用浏览器访问到"Welcome to nginx"。

做完这三件事，你就有了"自己的服务器"，后面所有实验都可以在它上面做。

### 准备：需要什么

- 一台能跑虚拟化的电脑（8G 内存以上比较舒服）
- VMware Player（免费）或 VirtualBox（免费），或 Windows 自带 Hyper-V
- Ubuntu Server 24.04 的 ISO（约 2.6GB）

下载地址搜 "Ubuntu Server 24.04 ISO" 即可，选 `ubuntu-24.04.x-live-server-amd64.iso`。

### 第一步：建虚拟机

以 VMware 为例：

1. 新建虚拟机 → 选择"稍后安装操作系统"。
2. 客户机系统选 Linux / Ubuntu 64 位。
3. 内存给 2048MB，CPU 给 2 核，磁盘给 20GB（单文件）。
4. 网络适配器选 **NAT**（最简单，能上网，不需要改路由）。
5. 挂载 ISO 到光驱，启动。

VirtualBox 对应设置：内存 2048、CPU 2、VDI 20G、网络 "NAT"。

### 第二步：安装

启动后按提示走，关键是三个地方：

- **网络**：默认 DHCP 就行，安装程序会自动拿到 IP。
- **磁盘**：选 "Use an entire disk"，会做 LVM 分区，直接确认。
- **用户**：不要跳过！创建一个普通用户，例如 `ops`，密码记下来。
- **OpenSSH server**：**一定要勾选**。这是后面能远程登录的前提。

装完会提示重启，重启后看到登录界面：

```
Ubuntu 24.04 LTS
ops login:
```

输入用户名密码，出现 `ops@ubuntu:~$` 就成功了。

### 第三步：让它能联网、能装软件

```bash
ip -br addr                 # 看 IP，一般是 192.168.x.x 或 10.x
ping -c 3 223.5.5.5         # 通不通
sudo apt update             # 更新软件源索引
sudo apt install -y curl vim htop
```

如果 `apt update` 报 DNS 错误：

```bash
cat /etc/resolv.conf
# 没有 nameserver 就加：
echo 'nameserver 223.5.5.5' | sudo tee /etc/resolv.conf
```

如果 ping 不通但能解析，检查虚拟机网络模式是否选对了（NAT 一般没问题）。

### 第四步：从自己的电脑 SSH 登录

在虚拟机里看 IP：

```bash
hostname -I
```

在**你自己的电脑**（Windows 用 PowerShell）里：

```bash
ssh ops@192.168.1.130
```

第一次会问 `Are you sure you want to continue connecting?`，输入 `yes`。

登录成功后提示符会变成 `ops@ubuntu:~$`，但这次是在你的终端里。**从此不需要再开虚拟机的窗口了**，这就是"服务器"的感觉。

Windows 自带 OpenSSH 客户端（Win10 1809 之后），如果没有：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
```

### 第五步：装 Nginx，用浏览器访问

```bash
sudo apt install -y nginx
systemctl status nginx --no-pager
```

在浏览器打开 `http://192.168.1.130`（换成你的 IP），看到 "Welcome to nginx!" 就成功了。

打不开的话按顺序查：

```bash
ss -lntp | grep nginx            # 有没有在 80 端口监听
sudo ufw status                  # 防火墙是不是拦了（默认 Ubuntu 未启用）
curl -I http://localhost         # 本机自己能访问吗
```

本机能访问、外部不能，就是网络模式或防火墙的问题。

### 第六步：把常用东西配好（可选但值得）

**换国内软件源（更快）**：

```bash
sudo sed -i 's|//archive.ubuntu.com|//mirrors.aliyun.com|g' /etc/apt/sources.list.d/ubuntu.sources
sudo apt update
```

**允许免密 sudo（个人实验机可以）**：

```bash
sudo visudo
# 末尾加一行：
# ops ALL=(ALL) NOPASSWD:ALL
```

**配 SSH 密钥登录**（比密码方便）：

```bash
# 在你自己的电脑上
ssh-keygen -t ed25519 -C "my-laptop"
ssh-copy-id ops@192.168.1.130
ssh ops@192.168.1.130            # 这次不需要密码
```

**装一个顺手的编辑器配置**：

```bash
cat >> ~/.vimrc <<'EOF'
set number
set tabstop=4
set expandtab
syntax on
EOF
```

### 第七步：给它一个固定的 IP（可选）

虚拟机每次重启 IP 可能变，很烦。用 netplan 固定：

```bash
sudo nano /etc/netplan/50-cloud-init.yaml
```

```yaml
network:
  version: 2
  ethernets:
    ens33:
      dhcp4: no
      addresses: [192.168.1.130/24]
      routes:
        - to: default
          via: 192.168.1.2
      nameservers:
        addresses: [223.5.5.5, 119.29.29.29]
```

```bash
sudo netplan apply
```

**改网络前一定要保证还有另一个方式能进虚拟机**（比如 VMware 的控制台窗口），否则 IP 配错就失联了。

### 你现在拥有了什么

- 一台可以随便折腾、搞坏了重新装 15 分钟的 Linux 服务器。
- 远程登录能力（SSH）。
- 一个能对外提供服务的进程（Nginx）。
- 一套能装软件、能查状态的日常工具链。

### 接下来做什么

按这个顺序继续，每一步都能独立跑通：

1. 在 `/var/www/html` 里改一个自己的页面。
2. 用 `nginx` 反代一个 Python 小服务（`python3 -m http.server 8000`）。
3. 装 Docker，用 `docker run` 起一个 MySQL。
4. 建一个定时任务（`crontab -e`），每周备份一次目录。
5. 用 Nginx 加一个 HTTPS（自签证书即可）。

### 一句话总结

第一台服务器的意义不是"能用"，而是**你有了一个可以随意试错的环境**——所有后面学的技术，都从这里开始长。
