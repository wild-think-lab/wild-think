---
title: 数据库是什么，怎么连上它
module: 入门篇
summary: 把这台"存数据的服务"讲清楚：它怎么组织和你在命令行里敲 SQL 的关系，装完为什么连不上，以及连接串里每个参数的意思。
minutes: 11
---

### 一句话说清

数据库是**一个长期在跑的服务程序**，它替你管文件、管并发、管崩溃恢复。你通过 SQL 告诉它"要什么"，它负责"怎么安全地做到"。

如果自己用 txt/csv 存数据，会遇到三个做不到的事：多人同时写、断电不丢、快速查找。数据库就是来解决这三个问题的。

### 装与启动

```bash
# Rocky/CentOS
sudo dnf install -y mysql-server
sudo systemctl enable --now mysqld
sudo grep 'temporary password' /var/log/mysqld.log   # 初始密码

# Ubuntu
sudo apt install -y mysql-server
sudo systemctl enable --now mysql
```

```bash
mysql -uroot -p
```

第一次登录先改密码：

```sql
ALTER USER 'root'@'localhost' IDENTIFIED BY 'Str0ng#2026';
```

### 为什么"连不上"

四种最常见的原因，按顺序排：

| 现象 | 原因 | 验证 |
| --- | --- | --- |
| `Can't connect to local MySQL server through socket` | 服务没启动 | `systemctl status mysqld` |
| `Access denied for user` | 密码错或用户不存在 | `SELECT user,host FROM mysql.user;` |
| 从另一台机器连不上 | 只监听 127.0.0.1 | `ss -tlnp \| grep 3306` |
| 监听 0.0.0.0 仍连不上 | 防火墙/安全组 | `firewall-cmd --list-ports` |

监听地址在 `/etc/my.cnf` 的 `bind-address`。改完要重启，并用 `ss` 确认。

### 给应用建一个专用账号

不要用 root 连应用。标准做法：

```sql
CREATE DATABASE shop DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'shop'@'10.10.10.%' IDENTIFIED BY 'App@2026';
GRANT SELECT, INSERT, UPDATE, DELETE ON shop.* TO 'shop'@'10.10.10.%';
FLUSH PRIVILEGES;
```

四条经验：

1. `utf8mb4` 而不是 `utf8`（后者存不了 emoji 和部分中文生僻字）。
2. `host` 用网段而不是 `%`，限制来源。
3. 权限给到"库级 + 具体动作"，不要 `ALL ON *.*`。
4. 应用账号不需要 `CREATE`/`DROP`，迁移由 DBA 或迁移脚本执行。

### 连接串怎么读

```
mysql://shop:App@2026@10.10.10.31:3306/shop?charset=utf8mb4
```

- `10.10.10.31:3306`：主机与端口。
- `shop`：库名。
- `charset`：必须显式设，默认可能不是 utf8mb4。

连接池参数（重要）：

| 参数 | 建议 | 原因 |
| --- | --- | --- |
| 最大连接数 | 20–50 | 与 `max_connections` 匹配，别让每个实例都开 100 |
| 空闲超时 | 小于数据库 `wait_timeout` | 否则拿到失效连接报错 |
| 连接检测 | 取连接前 ping 或测试查询 | 解决"隔夜第一个请求失败" |

### 先看几个基本信息

```sql
SELECT VERSION();
SHOW DATABASES;
SELECT @@character_set_server, @@max_connections, @@datadir;
SHOW VARIABLES LIKE 'innodb_buffer_pool_size';
SHOW PROCESSLIST;
```

`innodb_buffer_pool_size` 是最值得调的参数：**一般设物理内存的 50–70%**（专用数据库机器）。它太小，所有查询都在读磁盘。

### 本章验证

1. 装好 MySQL，用 `systemctl status` 确认在跑。
2. 建一个库和一个受限用户，从另一台机器用 `mysql -h` 连上。
3. 查 `innodb_buffer_pool_size`，说明它和内存的关系。

能连上、能建库、能授权，这三件事做完，你就有了一个可以开始写 SQL 的环境。
