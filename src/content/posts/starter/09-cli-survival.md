---
title: 命令行生存指南：新手最该先会的三十条命令
description: 按"找东西、看状态、改文件、查问题"四组编排，每条都给一句用途和一个真实例子，附三条救命技巧。
date: 2026-11-27
tags: [入门, 命令行, Linux, 效率]
---

### 组一：找东西（6 条）

```bash
# 1. 我现在在哪
pwd
# 2. 这个目录有什么（含隐藏文件、人类可读大小）
ls -lah
# 3. 按名字找文件
find /etc -name '*.conf' -type f
# 4. 在文件内容里搜
grep -rn "listen 80" /etc/nginx/
# 5. 找命令在哪
which nginx; type systemctl
# 6. 看文件前/后几行
head -20 app.log; tail -f app.log     # -f 实时跟随
```

**`tail -f` 是最高频的一条**：日志排障时离不开它。

### 组二：看状态（8 条）

```bash
# 7. 磁盘
df -hT; df -i                    # 空间与 inode
# 8. 目录占用
du -sh /var/log/* | sort -h
# 9. 内存
free -h
# 10. 进程与 CPU
top -o %CPU                      # 或 htop
# 11. 端口监听
ss -tlnp
# 12. 网络连接
ss -tunap | head -20
# 13. 系统负载与运行时间
uptime
# 14. 服务状态
systemctl status nginx
```

**`ss` 已经取代 `netstat`**（更快，字段更清晰）。`-t` TCP / `-u` UDP / `-l` 监听 / `-n` 不解析 / `-p` 显示进程。

### 组三：改文件（7 条）

```bash
# 15. 看整个文件（可分页搜索）
less app.log                      # / 搜索，G 到末尾，q 退出
# 16. 复制（保留属性、递归）
cp -a /src/. /dst/
# 17. 移动/改名
mv old.txt new.txt
# 18. 删除（危险！先 ls 确认）
rm -rf /tmp/build
# 19. 改权限
chmod 644 file; chmod +x script.sh
# 20. 改属主
chown -R app:app /opt/app
# 21. 改内容（替换）
sed -i 's/old/new/g' file
```

**删除前先 `ls` 同一路径**，这是最省事的保命习惯。

### 组四：查问题（9 条）

```bash
# 22. 测连通
ping -c 4 10.0.0.1
# 23. 测端口
nc -zv 10.0.0.1 3306              # 或 telnet
# 24. 测 HTTP
curl -i https://example.com; curl -o /dev/null -w '%{http_code}\n' https://example.com
# 25. 路由追踪
traceroute example.com            # 或被 mtr 取代
mtr -n example.com
# 26. 看系统日志
journalctl -u nginx -n 50 --no-pager
journalctl -p err -S today
# 27. 看内核/硬件消息
dmesg | tail -30                  # OOM、磁盘错误都在这
# 28. 抓包
tcpdump -i eth0 -nn port 80 -c 20
# 29. 查 DNS
dig example.com +short; dig @8.8.8.8 example.com
# 30. 查进程打开的文件
lsof -p <pid>; lsof +L1           # 已删除但仍被占用
```

### 三条救命技巧

**① 命令忘了参数**

```bash
man rsync            # 完整手册
rsync --help | head
tldr rsync           # 社区精简示例（需安装）
```

**② 上一条命令输了，想复用**

```bash
!!                   # 重复上一条
sudo !!              # 用 sudo 重跑上一条（最常用）
!$                   # 上一条命令的最后一个参数
Ctrl+R               # 反向搜索历史
history | grep ssh   # 找历史
```

**③ 命令卡住了**

```
Ctrl+C    中断
Ctrl+Z    挂起（bg 放到后台，fg 拿回来）
Ctrl+D    发送 EOF（退出交互程序）
Ctrl+L    清屏
```

**进程卡死但 Ctrl+C 无效**（D 状态）：

```bash
ps -o pid,stat,wchan -p <pid>     # stat 为 D 表示不可中断睡眠
# 这类进程 kill -9 也杀不掉，通常是等 IO（NFS 挂死最常见）
```

### 一次完整的排障（把命令串起来）

**现象**：网站打不开。

```bash
curl -I https://example.com            # 22/24：状态码是什么
dig example.com +short                 # 29：DNS 对不对
nc -zv example.com 443                 # 23：端口通不通
ss -tlnp | grep 443                    # 11：本机在监听吗
journalctl -u nginx -n 30              # 26：服务端报什么错
tail -f /var/log/nginx/error.log       # 6：实时看
```

六条命令，五分钟能定位到"DNS / 端口 / 服务 / 应用"哪一层。

### 别踩的三个坑

```
① rm -rf 变量为空 → 删根目录
   写 rm -rf "${DIR:?}"/ 而不是 rm -rf $DIR/
② cd 失败后继续执行 → 在错误目录里操作
   用 cd /path && cmd，而不是 cd /path; cmd
③ 通配符没匹配到 → 命令参数错乱
   rm *.log 在无匹配时会报错，但某些命令会"吃掉"参数
```

### 检查清单（自查）

```
□ 会用 find + grep 定位文件与内容
□ 会用 tail -f / less 看日志
□ 会用 ss -tlnp 看端口
□ 会用 curl 测接口与状态码
□ 会用 journalctl 看服务日志
□ 知道 sudo !! 与 Ctrl+R
□ 删除前会先 ls
□ 知道 D 状态进程杀不掉的原因
```
