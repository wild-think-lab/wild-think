---
title: 部署数据库服务：装、初始化与加固
module: 熟练篇
summary: MySQL/PostgreSQL 的安装与初始化、必须改的六个默认项、备份与监控的最小配置。
minutes: 50
---

### MySQL 安装（官方仓库）

```bash
dnf install -y https://dev.mysql.com/get/mysql80-community-release-el9-1.noarch.rpm
dnf install -y mysql-community-server
systemctl enable --now mysqld
grep 'temporary password' /var/log/mysqld.log
```

```bash
mysql_secure_installation
```

**"用系统自带 MySQL 5.7"** 在新系统上往往装不上或版本太老。

### PostgreSQL 安装

```bash
dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm
dnf -qy module disable postgresql
dnf install -y postgresql16-server
/usr/pgsql-16/bin/postgresql-16-setup initdb
systemctl enable --now postgresql-16
```

### 必须改的六个默认项

```
① 监听地址（默认只 127.0.0.1 或 localhost）
② 端口（如需对外，注意防火墙）
③ 数据目录（放到独立盘）
④ 字符集（utf8mb4 / UTF8）
⑤ 时区（统一 UTC 或本地，但全站一致）
⑥ 认证方式（密码强度 + 限制来源）
```

```conf
# MySQL
bind-address = 0.0.0.0
datadir = /data/mysql
character-set-server = utf8mb4
default-time-zone = '+08:00'
```

```conf
# PostgreSQL
listen_addresses = '*'
data_directory = '/data/pg'
timezone = 'Asia/Shanghai'
```

```
# pg_hba.conf：只允许应用网段
host app app 10.0.0.0/24 scram-sha-256
```

### 建库与账号（最小权限）

```sql
CREATE DATABASE app CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'app'@'10.0.0.%' IDENTIFIED BY '<强密码>';
GRANT SELECT,INSERT,UPDATE,DELETE ON app.* TO 'app'@'10.0.0.%';
-- 不要给 ALL，更不要给 *.*
```

**"给 root 远程登录"** 是最常见的坏习惯。

### 数据目录单独挂盘

```bash
# 停库 → 迁移 → 改配置 → 启动
systemctl stop mysqld
rsync -a /var/lib/mysql/ /data/mysql/
chown -R mysql:mysql /data/mysql
# 改 datadir 后注意 SELinux 上下文
semanage fcontext -a -t mysqld_db_t "/data/mysql(/.*)?"
restorecon -Rv /data/mysql
```

**"数据在系统盘"** → 系统盘满 = 数据库挂。

### 备份（装完就配）

```bash
# MySQL 逻辑
mysqldump --single-transaction -B app | gzip > /backup/app-$(date +%F).sql.gz
# PostgreSQL
pg_dump -Fc app > /backup/app-$(date +%F).dump
```

**"以后再说备份"** 通常等于永远没有。

### 监控三件事

```
① 连接数（是否打满）
② 慢查询（阈值 + 排行）
③ 磁盘空间（数据 + binlog/WAL）
```

```sql
SHOW STATUS LIKE 'Threads_connected';
SHOW VARIABLES LIKE 'slow_query_log';
```

### 五个"装完就有问题"

**① 磁盘满导致只读**

```
binlog 没清理 / 数据放系统盘
```

**② 时区不一致**

```
应用写入时间差 8 小时
```

**③ 字符集**

```
表是 latin1 → 中文乱码（建库时就要对）
```

**④ 认证方式不兼容**

```
PG scram-sha-256 vs 老客户端 md5
```

**⑤ SELinux 拦数据目录**

```
改 datadir 后没 restorecon
```

### 检查清单

```
□ 官方源安装（版本明确）
□ 数据目录独立挂盘
□ 字符集与时区统一
□ 只允许应用网段连接
□ 业务账号最小权限
□ 装完就配备份
□ 有慢查询与连接数监控
□ 有磁盘空间告警
□ SELinux 上下文正确
□ 有启动自启验证
```
