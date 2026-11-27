---
title: Nginx 配置速查
summary: 端口/虚拟主机/反代/负载均衡/TLS/限流/日志的常用片段，附"改完怎么验证"。
group: Service
order: 1
tags: [nginx, 反代, 配置]
---

## 一、改配置的标准流程

```bash
nginx -t                    # 先校验语法（必做）
nginx -s reload             # 平滑重载（不中断请求）
nginx -s quit               # 优雅停止
nginx -V                    # 看编译参数（模块是否编进去）
```

**`nginx -t` 通过才 reload**。语法错误时 reload 会失败但老进程继续跑（看起来"改了没生效"）。

## 二、目录结构

```
/etc/nginx/nginx.conf          主配置（含 include）
/etc/nginx/conf.d/*.conf       server 块（推荐放这里）
/etc/nginx/sites-enabled/      Debian 系（符号链接到 sites-available）
/etc/nginx/ssl/                证书
/var/log/nginx/access.log      访问日志
/var/log/nginx/error.log       错误日志
```

## 三、虚拟主机（最小可用）

```nginx
server {
    listen 80;
    server_name example.com www.example.com;
    root /var/www/example;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

## 四、反向代理（生产常用）

```nginx
upstream app {
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
    keepalive 32;
    keepalive_timeout 60s;
}

server {
    listen 443 ssl;
    http2 on;
    server_name app.example.com;

    ssl_certificate     /etc/nginx/ssl/app.crt;
    ssl_certificate_key /etc/nginx/ssl/app.key;

    client_max_body_size 100m;

    location / {
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;

        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}
```

## 五、负载均衡策略

```nginx
upstream app {
    # 默认：轮询
    server 10.0.0.1:8080 weight=3;
    server 10.0.0.2:8080 weight=1;

    # 最少连接（适合长请求）
    least_conn;

    # IP 哈希（会话保持）
    ip_hash;

    # 一致性哈希（缓存场景）
    hash $request_uri consistent;

    # 主动健康检查（需 nginx plus 或 第三方模块）
    server 10.0.0.3:8080 max_fails=3 fail_timeout=30s;
}
```

| 策略 | 适用 |
| --- | --- |
| 轮询（默认） | 无状态服务 |
| weight | 机器配置不同 |
| least_conn | 请求耗时差异大 |
| ip_hash | 需要会话粘性（不推荐，粘性=单点） |
| hash consistent | 缓存命中率 |

## 六、TLS 参数

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256';
ssl_prefer_server_ciphers off;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets on;
```

## 七、限流

```nginx
# 定义限流区（10m 内存 ≈ 16 万 IP）
limit_req_zone $binary_remote_addr zone=api:10m rate=100r/s;

# 连接数限制
limit_conn_zone $binary_remote_addr zone=conn:10m;

server {
    location /api/ {
        limit_req zone=api burst=200 nodelay;
        limit_conn conn 50;
        limit_req_status 429;
    }
}
```

**`nodelay` 的意义**：突发请求立即处理（不排队），但不超 `burst`。不写 `nodelay` 会让请求排队（增加延迟）。

## 八、常用 location 匹配

```nginx
location = /exact     { }     # 精确匹配（优先级最高）
location ^~ /static/  { }     # 前缀匹配且不再正则
location ~ \.php$     { }     # 正则（区分大小写）
location ~* \.(jpg|png)$ { }  # 正则（不区分）
location /            { }     # 普通前缀
```

**优先级**：`=` > `^~` > `~`/`~*` > 普通前缀。

## 九、静态资源优化

```nginx
location ~* \.(jpg|jpeg|png|gif|ico|css|js|woff2)$ {
    expires 30d;
    add_header Cache-Control "public, immutable";
    access_log off;
    tcp_nodelay off;
    sendfile on;
}
```

## 十、日志格式

```nginx
log_format main '$remote_addr - $remote_user [$time_local] '
                '"$request" $status $body_bytes_sent '
                '"$http_referer" "$http_user_agent" '
                'rt=$request_time uct=$upstream_connect_time '
                'uht=$upstream_header_time urt=$upstream_response_time '
                'rid=$request_id';

access_log /var/log/nginx/access.log main;
```

## 十一、重定向与跳转（谨慎）

```nginx
# 强制 HTTPS
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}
```

**`return 301` 与 `rewrite` 的区别**：`return` 不解析正则，性能更好，优先用 `return`。

## 十二、常见报错

| 错误 | 原因 |
| --- | --- |
| 413 Request Entity Too Large | `client_max_body_size` 太小 |
| 502 Bad Gateway | 上游不可达/超时/进程崩 |
| 504 Gateway Timeout | `proxy_read_timeout` 太短 |
| 499 | 客户端主动断开（通常是客户端超时） |
| 400 Bad Request | Host 头不匹配 / 请求过大 |
| 403 Forbidden | 目录权限 / `autoindex off` |
| "too many open files" | `worker_rlimit_nofile` / 系统 `ulimit` |

**499 很有用**：说明客户端先放弃了（通常是上游太慢）。

## 十三、性能相关

```nginx
worker_processes auto;
worker_connections 10240;
worker_rlimit_nofile 65535;
multi_accept on;

sendfile on;
tcp_nopush on;
tcp_nodelay on;
keepalive_timeout 65;
keepalive_requests 1000;

gzip on;
gzip_comp_level 5;
gzip_min_length 1024;
gzip_types text/plain text/css application/json application/javascript;
```

## 十四、验证清单

```bash
nginx -t                                  # 语法
curl -I https://example.com/              # 状态码与头
curl -H 'Host: app.example.com' localhost # 虚拟主机是否匹配
tail -f /var/log/nginx/error.log          # 实时错误
ss -lntp | grep nginx                      # 监听端口
```
