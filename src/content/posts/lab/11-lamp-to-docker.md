---
title: 实验报告：把 LAMP 老应用搬进 Docker
description: 从"一台机器装 PHP+MySQL+Apache"迁到"Compose 三容器"，讲清数据迁移、配置外置、切流与回滚的完整步骤。
date: 2023-08-16
tags: [实验, Docker, 迁移, LAMP]
---

### 一、实验目的

1. 把一台机器上的 LAMP 应用（Apache + PHP + MySQL）改造成容器化部署。
2. 数据不丢、URL 不变、可回滚。
3. 对比迁移前后的部署耗时与依赖复杂度。

### 二、原环境（迁移前）

| 项 | 值 |
| --- | --- |
| OS | Ubuntu 22.04 |
| Web | Apache 2.4 |
| PHP | 8.1（mod_php） |
| DB | MySQL 8.0（本机） |
| 站点 | /var/www/html/app |
| 域名 | app.example.com（Nginx 反代到 80） |

**老问题**：

```
① 换机器要手装一遍 Apache+PHP 扩展+MySQL，至少 2 小时
② PHP 扩展版本靠 apt，升级有风险
③ 数据库和应用在同一机器，资源互相争抢
```

### 三、目标结构

```
Nginx（宿主或容器，TLS 终止）
   ↓
app（PHP-FPM + Apache 或 nginx+fpm）容器
   ↓
mysql 容器（数据卷持久化）
```

本实验用"单个 PHP-Apache 容器 + MySQL 容器"最简结构。

### 四、准备

```bash
# 目录
mkdir -p /opt/app/{html,conf,data}
cp -a /var/www/html/app/. /opt/app/html/

# 导出数据库
mysqldump --single-transaction --routines --triggers \
  -u root -p appdb > /opt/app/data/appdb.sql
```

### 五、Dockerfile

```dockerfile
FROM php:8.1-apache

# 装扩展（替代 apt 装的 mod_php 扩展）
RUN docker-php-ext-install mysqli pdo pdo_mysql \
 && a2enmod rewrite headers

# 站点配置
COPY conf/000-default.conf /etc/apache2/sites-available/000-default.conf
COPY conf/php.ini /usr/local/etc/php/conf.d/zz-app.ini

# 代码（生产也可用 volume 挂载，便于热更新）
COPY html/ /var/www/html/

RUN chown -R www-data:www-data /var/www/html
EXPOSE 80
```

`conf/000-default.conf`：

```apache
<VirtualHost *:80>
    DocumentRoot /var/www/html
    <Directory /var/www/html>
        AllowOverride All
        Require all granted
    </Directory>
    ErrorLog /dev/stderr
    CustomLog /dev/stdout combined
</VirtualHost>
```

**日志写 `/dev/stdout`**：容器里日志走标准输出，由 Docker 收集（`docker logs`）。

### 六、Compose

```yaml
services:
  db:
    image: mysql:8.0
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: appdb
      MYSQL_USER: app
      MYSQL_PASSWORD: ${MYSQL_APP_PASSWORD}
    volumes:
    - ./data/mysql:/var/lib/mysql
    - ./data/init:/docker-entrypoint-initdb.d:ro
    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-p${MYSQL_ROOT_PASSWORD}"]
      interval: 10s
      retries: 5

  app:
    build: .
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      DB_HOST: db
      DB_NAME: appdb
      DB_USER: app
      DB_PASS: ${MYSQL_APP_PASSWORD}
    ports:
      - "127.0.0.1:8080:80"      # 只给本机 Nginx 用
```

`.env`（不进 Git）：

```
MYSQL_ROOT_PASSWORD=ChangeMeRoot
MYSQL_APP_PASSWORD=ChangeMeApp
```

**`127.0.0.1:8080:80`** 而不是 `8080:80`：避免容器端口直接暴露公网。

### 七、数据迁移

```bash
docker compose up -d db
# 等健康检查通过
docker compose ps
# 导入
docker compose exec -T db mysql -uroot -p"$MYSQL_ROOT_PASSWORD" appdb < data/appdb.sql
# 验证
docker compose exec db mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
  -e "SELECT count(*) FROM appdb.orders;"
```

**导入前先核对老库的行数**，导入后对比：

```bash
mysql -u root -p -e "SELECT count(*) FROM appdb.orders;"   # 老库
# 与容器内对比
```

### 八、应用配置外置

老代码里常把数据库密码写死在 `config.php`：

```php
// 改造前
$db = new mysqli('localhost', 'root', 'oldpass', 'appdb');

// 改造后
$db = new mysqli(
    getenv('DB_HOST'), getenv('DB_USER'), getenv('DB_PASS'), getenv('DB_NAME')
);
```

**这一步是迁移的核心价值**：配置从代码里出来，换环境只改 `.env`。

### 九、切流

```nginx
# 宿主 Nginx：原配置
upstream app_old { server 127.0.0.1:80; }       # 老 Apache

# 新配置（灰度）
upstream app_new { server 127.0.0.1:8080; }

# 第一周：只让内部 IP 走新容器
split_clients "${remote_addr}" $upstream_pick {
    10%     app_new;
    *       app_old;
}
```

更简单的做法：

```
① 先把新容器跑起来，用 hosts 绑定在测试机上验证
② 验证通过后改 Nginx upstream 指向 8080
③ 观察 30 分钟（错误率、慢请求）
④ 老 Apache 保留 3 天，随时回滚
```

回滚：把 upstream 改回 80，`nginx -s reload`，10 秒内完成。

### 十、验证清单

```bash
# 1. 页面可访问
curl -I http://127.0.0.1:8080/
# 2. 数据库连接正常（看应用的日志）
docker compose logs app --tail 50
# 3. 写操作正常（提交一个表单/下一个单）
# 4. 文件上传能落盘（检查卷挂载）
# 5. 日志能出来
docker compose logs app | tail
# 6. 重启后仍正常
docker compose restart
```

### 十一、迁移前后对比

| 项 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 新机器部署耗时 | 约 2 小时 | 约 10 分钟（`docker compose up`） |
| PHP 扩展管理 | apt 装，版本受发行版限制 | Dockerfile 声明，可复现 |
| 配置管理 | 散落在 `/etc` 与代码里 | 集中在 `.env` 与 Compose |
| 回滚 | 重装/恢复快照 | 改 upstream，10 秒 |
| 资源隔离 | 无 | 容器级（可加 limits） |

### 十二、注意事项

1. **不要用 `latest` 标签**：`mysql:8.0`、`php:8.1-apache`，版本可复现。
2. **数据必须用卷**（bind mount 或 named volume），不要放在容器内。
3. **数据库字符集要显式设**，否则中文可能变问号。
4. **文件权限**：容器内 `www-data` 与宿主 UID 可能不一致，上传目录会写不进去。
5. **不要在容器里改代码**：改代码要走镜像重建，否则"重启就丢"。

### 十三、总结

容器化 LAMP 的最大收益不是"用上了 Docker"，而是：

```
① 部署变成可复现（Dockerfile + Compose 就是文档）
② 配置与代码分离（换环境只改环境变量）
③ 回滚变快（改一个 upstream 或换一个 tag）
```

老系统迁移不要一次重写，**先"容器化"再"重构"**，两步分开做。

### 附录：一键脚本

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/app

[[ -f .env ]] || { echo "missing .env"; exit 1; }

docker compose build
docker compose up -d
docker compose ps

until curl -sf http://127.0.0.1:8080/ >/dev/null; do
  echo "waiting app..."; sleep 3
done
echo "app is up on 127.0.0.1:8080"
```
