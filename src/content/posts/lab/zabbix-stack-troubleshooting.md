---
title: 实验：Zabbix 502 / 前端空白 / 数据库连不上的分层排错
description: Zabbix 的故障几乎都能归到"PHP-FPM → Web 服务器 → MariaDB → zabbix-server"四层之一。按层给出日志位置、判据命令与常见根因。
date: 2026-10-26
tags: [Zabbix, PHP-FPM, MariaDB, CentOS7, 排错, 实验]
---

Zabbix 重装或迁移后最常见的三种表现：打开页面 **502 Bad Gateway**、页面**全白但 HTTP 200**、**"Database error"**。三者分别对应不同的层，混着查会浪费很多时间。

## 分层模型

```
浏览器 → Nginx/Apache → PHP-FPM → MariaDB
                ↑              ↑
          zabbix-server（后台进程，独立连库）
```

判据：**先确定坏在"能不能出字节"还是"出的是错误内容"**。

```bash
curl -I http://127.0.0.1/zabbix/          # 502 说明 FPM 层坏
curl -s http://127.0.0.1/zabbix/ | head  # 200 但空白 = PHP 执行时报错
```

## 第一层：502 —— FPM 没在服务

502 的含义是"上游（FPM）没有返回合法响应"，几乎总是 FPM 进程问题。

```bash
systemctl status php-fpm
ss -lntp | grep -E '9000|php'                 # 是否在监听
tail -50 /var/log/php-fpm/error.log
tail -50 /var/log/nginx/error.log              # "connect() failed (111: Connection refused)"
```

常见根因：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `connect() failed ... 9000` | FPM 未启动 / 端口不对 | 启服务，核对 nginx 的 `fastcgi_pass` |
| `Permission denied` 访问 socket | SELinux 或 socket 权限 | `setsebool -P httpd_can_network_connect 1`，或改 TCP |
| FPM 启动即退出 | 配置语法错 / 目录缺失 | `php-fpm -t` 校验 |
| 偶发 502 | FPM 进程池耗尽 | 调 `pm.max_children`，看 `pm.max_children` 与实际并发 |

```bash
# 校验 FPM 配置（指定配置文件）
php-fpm -t -c /etc/php.ini -y /etc/php-fpm.conf
```

进程池耗尽的判据：`/var/log/php-fpm/error.log` 里出现 `server reached pm.max_children setting`。

## 第二层：页面空白（200 但无内容）

PHP 执行出错但 `display_errors=Off`，浏览器只拿到空白页。

```bash
# 1) 打开错误日志，而不是打开 display_errors
php -i | grep -E 'error_log|log_errors|display_errors'

# 2) 直接看日志
tail -100 /var/log/php-fpm/www-error.log
tail -100 /var/log/httpd/error_log

# 3) 命令行复现，绕过 Web 层
sudo -u apache php -f /usr/share/zabbix/index.php 2>&1 | head -30
```

常见根因：`php_value max_execution_time` 太小导致中断、`session.save_path` 不存在或不可写、`zabbix.conf.php` 里数据库配置错误、PHP 扩展缺失（`bcmath`、`gd`、`ldap`、`mysqli`）。

```bash
php -m | grep -E 'bcmath|gd|mysqli|ldap|xmlreader|xmlwriter'
```

Zabbix 前端要求的扩展缺一个就可能白屏。**缺扩展表现为白屏而不是报错，这是最容易误判的一类。**

## 第三层：MariaDB 连接失败

报错形如 `Database error: Access denied for user 'zabbix'@'localhost'` 或 `Can't connect to local MySQL server through socket`。

```bash
# 服务状态与端口
systemctl status mariadb
ss -lntp | grep 3306

# 用应用账号实测（密码从 /etc/zabbix/zabbix_server.conf 取 DBPassword）
mysql -uzabbix -p'<pwd>' -h127.0.0.1 zabbix -e 'select 1;'

# 错误日志
tail -100 /var/log/mariadb/mariadb.log
```

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `Access denied` | 账号/密码/主机授权不匹配 | `SELECT user,host FROM mysql.user;` 补 `'zabbix'@'127.0.0.1'` 授权 |
| `Can't connect ... socket` | 用了 unix socket 但路径不一致 | 统一 `-h127.0.0.1` 或配 `socket=` |
| 连接数满 | `max_connections` 太小 | `SHOW STATUS LIKE 'Threads_connected';` 与 `max_connections` 对比 |
| 表不存在 | 未导入 schema | `zcat create.sql.gz | mysql -uzabbix -p zabbix` |

授权示例（注意 host 部分是关键）：

```sql
CREATE USER 'zabbix'@'127.0.0.1' IDENTIFIED BY '***';
GRANT ALL ON zabbix.* TO 'zabbix'@'127.0.0.1';
FLUSH PRIVILEGES;
```

## 第四层：zabbix-server 自身

前端能开但没数据，问题在 server 进程。

```bash
systemctl status zabbix-server
tail -100 /var/log/zabbix/zabbix_server.log
grep -E 'DBHost|DBName|DBUser|DBPassword|StartPollers' /etc/zabbix/zabbix_server.conf
```

判据：日志里出现 `cannot connect to database` 说明配置读取失败（SELinux 拦截读取 `/etc/zabbix/zabbix_server.conf` 时也会这样）。检查：

```bash
ls -Z /etc/zabbix/zabbix_server.conf
journalctl -t setroubleshoot --since "10 min ago" | tail
```

## 一次完整的分层验证脚本

```bash
#!/bin/bash
echo "== 1. 服务 =="; systemctl is-active php-fpm mariadb zabbix-server nginx httpd 2>/dev/null
echo "== 2. 监听 =="; ss -lntp | grep -E ':80|:443|:3306|:9000|:10051'
echo "== 3. HTTP =="; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/zabbix/
echo "== 4. PHP =="; php -v | head -1; php -m | grep -cE 'bcmath|gd|mysqli'
echo "== 5. DB =="; mysql -uzabbix -p"$ZBX_PASS" -h127.0.0.1 zabbix -e 'select count(*) from hosts;' 2>&1 | tail -3
echo "== 6. 日志尾 =="
tail -5 /var/log/php-fpm/error.log /var/log/zabbix/zabbix_server.log 2>/dev/null
```

按 1→6 的顺序输出，基本一眼能看出坏在哪一层。

> 三条经验：**502 一定先看 FPM 而不是 Nginx；白屏一定先看 `www-error.log` 而不是 `display_errors`；数据库报错一定先核对"账号+host"而不是改密码。**
