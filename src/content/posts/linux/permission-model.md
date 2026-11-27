---
title: Linux 权限模型：rwx、特殊位、ACL 与 capability 各自解决什么问题
description: 权限问题几乎从不是"chmod 777 就能解决"，而是你没分清 DAC、特殊权限位、ACL 与 capability 这四层机制各管什么。
date: 2026-11-18
tags: [Linux, 权限, ACL, capability, 安全]
---

`Permission denied` 出现在 `ls -l` 看起来"权限没问题"的时候，通常意味着你只看了四层机制里的第一层。

## 一、第一层：基础 DAC（rwx）

文件：`r` 读内容，`w` 写内容，`x` 执行/进入。目录的语义不同：`r` 列目录、`w` 增删改条目、`x` 进入并可访问其中的 inode。

判定顺序是**内核按 UID/GID 逐级匹配后立即停止**，不是"取最大权限"：owner 命中就用 owner 的三位，owner 不命中再看 group，最后 other。所以"给 group 加了 w 但 owner 自己没有"是无效的——owner 匹配优先生效。

```bash
# 查看 umask，决定新建文件的默认权限（文件 666、目录 777 减去 umask）
umask
# 数值法 / 符号法
chmod 750 deploy.sh
chmod u+x,g-w,o-rwx deploy.sh
```

`root` 并非无限制：执行 `x` 位仍然需要文件本身可执行；写入只读文件系统或 `immutable` 属性时同样会失败。

## 二、第二层：特殊权限位

| 位 | 八进制 | 作用 | 典型场景 |
| --- | --- | --- | --- |
| SUID | 4000 | 执行时以文件 owner 身份运行 | `passwd`、部分自定义提权工具 |
| SGID | 2000 | 文件：以 group 身份运行；目录：新建文件继承该目录 group | 协作目录 |
| Sticky | 1000 | 目录内文件只有 owner 可删除 | `/tmp` |

协作目录的标准做法：

```bash
sudo groupadd devops
sudo chgrp devops /srv/app
sudo chmod 2775 /srv/app      # 2 = SGID，保证新文件继承 devops 组
```

SUID 是安全审计的重点。全盘排查：

```bash
sudo find / -xdev -perm -4000 -type f -ls 2>/dev/null
```

发现 SUID 的 `bash`、`cp`、`vim` 基本等于已经失守——它们能被直接用来保权。这类文件应改为最小必要集。

## 三、第三层：ACL，当"三位"不够用时

场景：`/data/reports` 需要对 3 个不同用户给不同权限，而他们不在同一个组里。改 group 会牵连其他人，属主也不能换。这时用 ACL。

```bash
# 需要文件系统挂载时带 acl（现代发行版 ext4/xfs 默认开启）
mount | grep acl
# 查看与设置
getfacl /data/reports
setfacl -m u:alice:rx,u:bob:r /data/reports
setfacl -m d:g:devops:rwx /data/reports    # d: 前缀是默认 ACL，对新建子项生效
```

注意 `ls -l` 权限位末尾会出现 `+`，这才是"ACL 生效"的标志，此时用 `ls -l` 判断权限必然误判。

清除：

```bash
setfacl -b /data/reports          # 删所有 ACL
setfacl -k /data/reports          # 只删默认 ACL
```

## 四、第四层：capability，把 root 拆成零件

容器与非 root 服务需要绑定低端口、改网络配置时，传统做法是给 SUID 或干脆 root 跑。capability 允许只授予某一项能力。

```bash
# nginx 需要绑定 80，只给这一项
sudo setcap 'cap_net_bind_service=+ep' /usr/sbin/nginx
getcap /usr/sbin/nginx

# 查看进程实际持有的能力集合
grep Cap /proc/<pid>/status
capsh --decode=$(grep CapEff /proc/<pid>/status | awk '{print $2}')
```

常见能力：`CAP_NET_BIND_SERVICE`（<1024 端口）、`CAP_NET_ADMIN`（网络配置）、`CAP_SYS_TIME`（改时钟）、`CAP_DAC_OVERRIDE`（绕过文件权限检查，等价半根）。

容器里 `--cap-add` / `--cap-drop` 本质就是改这套位图。默认应 `--cap-drop=ALL` 再按需加，这是最小权限原则最直接的落地方式。

## 五、还有几层容易被忽略

- **SELinux / AppArmor**：DAC 之上还有强制访问控制。`Permission denied` 但 `ls -Z` 上下文不对时，先 `ausearch -m avc -ts recent` 看是不是被 SELinux 拦了，别急着改权限。
- **文件属性 `immutable`**：`lsattr` 能看到 `i` 标志，此时 root 也不能改，`chattr -i` 才行。
- **挂载选项**：`noexec`、`nosuid`、`ro` 会让权限位失效，`findmnt` 先看挂载参数。
- **NFS / SMB**：服务端 `root_squash` 会把 root 映射成 `nobody`，客户端看到的现象是"我是 root 却写不进去"。

## 六、排障顺序（照这个顺序走，少走弯路）

1. `id` 确认当前真实 UID/GID，以及所属全部组（`groups` 只显示主组之外，容易漏）。
2. `ls -l` 看 owner/group，注意是否有 `+`（ACL）。
3. `namei -l /path/to/file` 逐级检查**路径上每一层目录**的执行权限——90% 的"文件权限对但访问不了"卡在父目录。
4. `getfacl` / `getcap` / `lsattr` / `ls -Z` 依次排查 ACL、能力、属性、安全上下文。
5. `findmnt` 看挂载选项与服务端映射。

> `chmod -R 777` 不是修复，是把问题从"一个服务起不来"变成"整台机器不可审计"。真正常见的正解是第 3 步：父目录缺 `x`。
