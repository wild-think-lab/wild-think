---
title: 部署 Web 服务：Nginx 从装到能对外
module: 熟练篇
summary: 安装与目录结构、虚拟主机与 TLS、反向代理、日志与限流、以及五个"配完 502/403"的原因。
minutes: 50
---

## 一、先弄懂它是什么

**Nginx 是一台"HTTP 前置机"：接住外部连接，然后要么自己返回文件，要么转发给后端。**

```
客户端 → Nginx（TLS 终止 + 路由 + 限流 + 日志）→ 静态文件 / 后端应用
```

**为什么前面要有一层**：应用服务器（Java/Node/Python）擅长业务，不擅长"抗慢连接、管证书、扛并发、做统一日志"。把这四件事交给 Nginx，是标准的分层。

### 它为什么能扛高并发

```
① epoll 事件驱动：一个进程管理上万连接，不靠"一连接一线程"
② 少量 worker 进程（≈ CPU 核数），每进程单线程事件循环
③ 静态文件用 sendfile 零拷贝，不经过用户态内存
```

**判据**：Nginx 的瓶颈通常在"内存带宽/磁盘/后端"，而不是"连接数"。

### 关键概念

| 概念 | 含义 | 配置位置 |
| --- | --- | --- |
| server block | 虚拟主机（按域名/端口区分） | `server { ... }` |
| location | 路径匹配规则（= 精确、^~ 前缀优先、~ 正则） | `location /api/` |
| upstream | 后端服务器组 + 负载策略 | `upstream app { }` |
| TLS 终止 | 在 Nginx 解密，后端走明文/内网 | `ssl_certificate` |
| 反向代理头 | 把真实客户端信息传给后端 | `X-Forwarded-For` |
| 限流 | 按 IP/连接数限速 | `limit_req_zone` |

### 匹配优先级（配错就是 404/403 的根源）

```
= 精确匹配 → ^~ 前缀（命中即停止正则）→ ~ / ~* 正则 → 普通前缀
```

**常见错**：写了 `location /api {}` 又写了 `location ~ \.php {}`，结果正则先命中，请求跑去了 PHP。

### 和 Apache、应用内置服务器的区别

| 方案 | 并发模型 | 适合 |
| --- | --- | --- |
| Nginx | 事件驱动，异步 | 高并发静态/反代/网关 |
| Apache prefork | 进程/线程，同步 | 老应用、.htaccess 依赖 |
| 应用内置（如 Tomcat） | 线程池 | 直接对外暴露风险大 |
| 云 LB / Envoy | 专用数据面 | 大规模、需要精细治理 |

### 边界

```
Nginx 不做：业务逻辑、复杂鉴权、服务发现（要配 upstream 或 DNS）
它也保不了：后端慢导致的 504（那是后端问题）
```

### 安装（两种系统）

```bash
# Debian/Ubuntu
apt-get update && apt-get install -y nginx

# RHEL/CentOS（需 EPEL）
dnf install -y nginx
systemctl enable --now nginx
```

**验证**：

```bash
nginx -t
ss -lntp | grep :80
curl -I http://127.0.0.1
```

### 目录结构（别乱放）

```
/etc/nginx/nginx.conf          主配置
/etc/nginx/conf.d/*.conf       站点配置（推荐）
/var/log/nginx/                日志
/usr/share/nginx/html          默认站点
```

**"全塞进 nginx.conf"** → 改一次要重启整站，且难以复用。

### 一个静态站点

```nginx
server {
    listen 80;
    server_name example.com;
    root /var/www/example;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    location ~* \.(js|css|png|jpg|svg|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

```bash
mkdir -p /var/www/example && chown -R www-data:www-data /var/www/example
```

### TLS（用 certbot）

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d example.com -d www.example.com
systemctl list-timers | grep certbot
```

**要点**：

```
① 证书自动续期（systemd timer）
② 80 端口保留（用于续期验证）
③ 有"证书剩余天数"监控
```

### 反向代理（最常见的用法）

```nginx
upstream app {
    server 10.0.0.11:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.12:8080 max_fails=3 fail_timeout=10s;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name app.example.com;

    location / {
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 3s;
        proxy_read_timeout 30s;
    }
}
```

**`proxy_http_version 1.1` + `Connection ""`** 才能复用长连接（否则每次新建）。

### 日志与限流

```nginx
log_format main '$remote_addr $host "$request" $status $body_bytes_sent '
                '$request_time $upstream_response_time "$http_user_agent"';
access_log /var/log/nginx/access.log main;

limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;
location /api/ {
    limit_req zone=api burst=40 nodelay;
    limit_req_status 429;
}
```

**"没有 $request_time"** → 无法判断"慢在网关还是后端"。

### 五个"配完 502/403"

**① 502：后端连不上**

```
proxy_pass 地址/端口错 / 后端没监听 / 防火墙
→ 看 error.log 的 connect() failed
```

**② 504：后端慢**

```
proxy_read_timeout 太短 / 后端真慢
```

**③ 403：权限/索引**

```
目录没有 index / 文件权限不对 / SELinux
```

**④ 413：请求体太大**

```
client_max_body_size 默认 1m
```

**⑤ 499：客户端主动断开**

```
后端响应太慢，用户先关了
（不是 Nginx 的错，是性能问题）
```

### 检查清单

```
□ 站点配置在 conf.d（不改主配置）
□ nginx -t 通过再 reload
□ TLS 自动续期 + 到期监控
□ 反代复用长连接（1.1 + Connection ""）
□ 透传 Host / X-Forwarded-*
□ 日志含 request_time 与 upstream_time
□ 有 body 大小与限流
□ 有 5xx 告警
□ reload 而非 restart（不断连接）
□ 有回滚（保留上一版配置）
```
