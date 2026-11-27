---
title: 日志与排错：从"打不开"到定位原因
module: 进阶篇
summary: journalctl 与 /var/log 两条线，加上一套五步排查顺序，把"服务挂了"拆成可验证的小问题。
minutes: 22
---

### 排错不是猜，是缩小范围

最没效率的做法是"到处改配置碰运气"。有顺序的做法是：**先确认现象属于哪一层，再去那一层看日志。**

五步顺序，按命中率排序：

1. 服务起了吗？→ `systemctl status`
2. 端口在监听吗？→ `ss -lntp`
3. 本机连得通吗？→ `curl localhost`
4. 外部连得通吗？→ 防火墙 / 安全组
5. 应用自己报什么错？→ 应用日志

### 两个日志入口

**systemd 统一日志**（现代系统首选）：

```bash
journalctl -u nginx -n 50 --no-pager   # 某服务最近 50 行
journalctl -u nginx -f                 # 实时跟随
journalctl --since "10 min ago"        # 时间范围
journalctl -p err -b                   # 本次开机的错误级别日志
```

**传统文件日志**：

| 文件 | 内容 |
| --- | --- |
| `/var/log/syslog`（Debian）/ `messages`（RHEL） | 系统总体 |
| `/var/log/auth.log` / `secure` | 登录、sudo 记录 |
| `/var/log/nginx/error.log` | nginx 应用错误 |
| `/var/log/nginx/access.log` | 每条访问记录 |

搜日志的正确姿势是先缩小范围再搜：

```bash
grep -i "error" /var/log/nginx/error.log | tail -20
journalctl -u myapp --since "5 min ago" | grep -i fail
```

### 三个真实故障，走一遍

**① 403 Forbidden**

`systemctl status` 显示 running，端口在听，`curl localhost` 返回 403 —— 服务和网络都没问题，问题在**权限**。

```bash
ls -ld /var/www/html          # 目录权限
ls -l /var/www/html/index.html
ps aux | grep nginx | head -1 # 服务以哪个用户跑
```

结论通常是：服务以 `www-data` 跑，但目录属主是 root 且 `700`，读不到。修法是 `chown -R www-data:www-data` 或放宽目录权限，而不是 `chmod 777`。

**② 502 Bad Gateway**

nginx 在跑，但后端（PHP/Python）没起来或崩了，nginx 连不上后端。

```bash
ss -lntp | grep 9000        # 后端端口在听吗
journalctl -u php-fpm -n 30 # 后端为什么崩
tail -20 /var/log/nginx/error.log   # 会明确写 connect() failed
```

**③ 端口占用 / 起不来**

```bash
journalctl -u myapp -n 30 | grep -i "address already in use"
ss -lntp | grep :8080
```

### 日志里的关键信息怎么读

- **时间戳**：先对齐时间，别把昨天的旧错误当今天的。
- **级别**：`ERROR`/`FATAL` 是真问题，`WARN` 常常可以放后面看。
- **最内层原因**：一串报错里，最后那条 `caused by` 通常是根因。

### 自己验证：制造一次故障

```bash
sudo systemctl stop nginx
curl -I http://localhost        # 期望 connection refused
sudo systemctl status nginx     # 看到 inactive (dead)
journalctl -u nginx -n 10 --no-pager
sudo systemctl start nginx
curl -I http://localhost        # 恢复 200/301
```

亲手制造一次、观察一次，比读十遍文档有用。

### 本章小结

- 按"服务 → 端口 → 本机 → 外部 → 应用日志"五步缩小范围。
- `journalctl -u 服务名` 是现代 Linux 查服务问题的第一入口。
- 403 查权限、502 查后端、起不来查端口占用。
- 日志先对齐时间，再找最内层原因。

**这门课读完了。** 接下来做一次实战作业：[实验报告式教程：从零源码部署一套 LAMP](/wild-think/writing/lamp-deployment-lab-report/)，那是把前 8 章全串起来的一次练习。
