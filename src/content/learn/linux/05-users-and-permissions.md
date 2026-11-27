---
title: 权限与用户：为什么总被 Permission denied
module: 基础篇
summary: 读懂 ls -l 那串字母，理解 rwx 三位一组，弄明白"为什么我必须加 sudo"和"为什么脚本跑不起来"。
minutes: 18
---

### 一条报错，三个可能

`Permission denied` 只有三种原因，排完就好：

1. 你**不是文件所有者**，也没被授权（→ 加 `sudo`，或改所有者）。
2. 你有读权限但**没有执行权限**（→ `chmod +x`）。
3. 上级**目录**不允许你进入（→ 目录也需要 `x` 权限）。

### 读懂 `ls -l` 的第一列

```bash
ls -l /etc/passwd
# -rw-r--r-- 1 root root 2893 Nov 27 10:00 /etc/passwd
```

拆成四段看：

```text
-   rwx   r--   r--
│    │     │     └── 其他人（others）的权限
│    │     └──────── 所属组（group）的权限
│    └────────────── 所有者（owner）的权限
└─────────────────── 文件类型：- 普通文件，d 目录，l 软链接
```

`r` 读、`w` 写、`x` 执行。三位一组，分别对应所有者 / 组 / 其他人。

### 数字表示法：rwx = 421

每位权限有分值：`r=4`、`w=2`、`x=1`，加起来就是这一位的数字。

| 权限 | 数字 | 含义 |
| --- | --- | --- |
| `rwx` | 7 | 读写执行 |
| `rw-` | 6 | 读写 |
| `r-x` | 5 | 读+执行（脚本、目录常用） |
| `rwx r-x r-x` | 755 | 所有者全权，其他人能读能跑 |
| `rw- r-- r--` | 644 | 文件默认，所有人可读，只有主能改 |
| `rwx rwx rwx` | 777 | 谁都能改——**线上绝对不要** |

```bash
chmod 755 deploy.sh      # 数字法
chmod +x deploy.sh       # 符号法，给所有位加执行
chmod u+w,g+r file       # 只给所有者加写、给组加读
```

### 目录的 x 权限容易被忽略

目录的 `x` 是"**能否穿过这个目录进入下层**"。所以：

```bash
chmod 644 /opt/app       # 目录变成 644，谁也别想进去
# 结果：/opt/app/config.yml 明明 644 可读，却打不开——因为进不去目录
```

目录的常见组合：`755`（能进能看）、`700`（只有主人能进）。

### 为什么总要 sudo

`sudo` 是"以 root 身份执行这一条命令"。系统目录（`/etc`、`/usr`、`/var/log`）的主人是 root，普通用户天然改不了，这不是系统在为难你，是它在保护自己。

```bash
sudo -i            # 切到 root 的交互 shell（危险，干完记得 exit）
sudo systemctl restart nginx
sudo visudo        # 改 sudo 权限的唯一正确方式（它会检查语法）
```

反面教材：`sudo chmod -R 777 /`、`sudo chown -R www:www /`（把整个系统交给 www 用户）。这类命令能让你"暂时不报错"，代价是系统从此不安全。

### 用户、组、属主

```bash
id                    # 我是谁，在哪些组
whoami
useradd -m dev         # 建用户，-m 同时建家目录
passwd dev             # 设密码
usermod -aG wheel dev  # 加进 wheel 组（Debian 系是 sudo 组）
chown -R nginx:nginx /var/www/html   # 改属主和属组
```

Web 服务起不来的经典原因之一：程序以 `nginx` 用户运行，但它要读的目录属主是 root 且 `700`——读不到，报 403。第 8 章会把这个链条完整走一遍。

### 自己验证

```bash
cd ~/lab
echo 'echo hello' > t.sh
./t.sh                       # Permission denied
ls -l t.sh                   # 看到 -rw-r--r--，没有 x
chmod +x t.sh && ./t.sh      # 输出 hello
```

### 本章小结

- 权限三位一组：所有者 / 组 / 其他人，各含 rwx。
- `chmod 755` 脚本和目录、`chmod 644` 普通文件。
- 目录的 `x` 决定能不能进去，`r` 决定能不能列内容。
- 系统目录归 root，所以要 `sudo`；`777` 不是解决方案。

**下一章**：怎么装软件——以及为什么"照着教程装不上"。
