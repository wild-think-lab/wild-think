---
title: Nginx 反向代理：配置骨架、缓冲调优与 502/504 排查
description: 一个能直接上线的 proxy 配置骨架、upstream 健康检查与重试、buffer 与超时参数怎么定、TLS 参数基线，以及 502/504/499 各自该往哪儿查。
date: 2022-05-28
tags: [Nginx, 反向代理, TLS, 排障, 运维]
---

### 一个能直接上线的骨架

不要从零开始写。下面这段涵盖了 90% 的 Web 反向代理需求：

```nginx
upstream app_pool {
    least_conn;                       # 长连接场景比轮询更均衡
    server 10.0.0.11:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.12:8080 max_fails=3 fail_timeout=10s;
    keepalive 32;                     # 到后端的连接池，必须配
    keepalive_requests 1000;
    keepalive_timeout 60s;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name app.example.com;

    ssl_certificate     /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    client_max_body_size 32m;
    client_body_timeout  20s;
    client_header_timeout 20s;

    add_header X-Request-Id $request_id always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://app_pool;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id      $request_id;

        proxy_connect_timeout 5s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;

        proxy_buffering on;
        proxy_buffers 8 16k;
        proxy_buffer_size 16k;
        proxy_busy_buffers_size 32k;

        proxy_next_upstream error timeout http_502 http_503;
        proxy_next_upstream_tries 2;
    }
}
```

几个容易被抄错的点：

- **`proxy_set_header Connection ""`**：不清空的话，客户端带来的 `Connection: close` 会被透传，`keepalive` 连接池直接失效。
- **`proxy_http_version 1.1`**：HTTP/1.0 不支持 keepalive，两者必须成对出现。
- **`X-Forwarded-*` 三件套**：后端要拿真实 IP 和协议，缺一个就会出现"日志里全是 10.0.0.1"或"重定向到 http"。
- **`X-Request-Id`**：用 `$request_id` 打通前后端日志，出问题时抓一条就能串起来。

### 超时参数怎么定

超时的本质是"你愿意等多久"。三个数字要跟后端对齐：

| 参数 | 含义 | 建议 |
| --- | --- | --- |
| `proxy_connect_timeout` | 连后端 | 3–5s，后端在同机房不该超过 1s |
| `proxy_send_timeout` | 往后端写 | 60s，大文件上传适当放大 |
| `proxy_read_timeout` | 等后端响应 | 等于后端 P99 的 1.5 倍，报表类接口单独 `location` 放长 |

如果后端是同步阻塞模型（比如老式 PHP-FPM），`proxy_read_timeout` 设太短会把正常慢查询变成 504；设太长则故障时前端全卡住。**按接口分类**定，比全局一刀切靠谱。

### 502 / 504 / 499 分别是什么

这三个码是 Nginx 排障的日常，含义完全不同：

- **502 Bad Gateway**：Nginx 从后端拿到了无效响应，或者根本连不上。
  - 后端进程没起来 / 端口不对 → `ss -lntp | grep 8080`
  - 后端起太快崩了（配置错误）→ 看 `error.log` 里的 `connect() failed (111: Connection refused)`
  - 后端返回了非法响应头（比如 header 里有中文）→ `upstream sent invalid header`
  - PHP-FPM 队列满 → `server reached pm.max_children`
- **504 Gateway Timeout**：等后端超过了 `proxy_read_timeout`。
  - 后端真的慢 → 看后端自己的慢日志 / `EXPLAIN`
  - 连接池被占满，请求在排队 → 检查 `keepalive` 与后端并发数
  - DNS 解析慢（`proxy_pass` 用了域名且没走 upstream）→ 用 upstream + `resolver` 缓存
- **499 Client Closed Request**：**客户端先断了**，不是服务端错误。常见于前端超时设置比 Nginx 短、用户手点关闭、移动网络切网。大量 499 说明前端超时太激进或接口太慢，别去改 Nginx。

查的时候按这个顺序，能省一半时间：

```bash
tail -f /var/log/nginx/error.log            # 先看有没有 upstream 报错
awk '{print $9}' access.log | sort | uniq -c | sort -rn | head   # 状态码分布
grep -c ' 502 ' access.log
ss -s                                        # 连接数是否异常
```

### TLS 参数基线

2026 年还在开 TLS 1.0/1.1 的，基本都会被扫描器标红。一个够用且兼容性尚可的配置：

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;      # TLS1.3 时代交给客户端选更高效
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;            # 会话票据有前向安全争议，可关
ssl_stapling on;
ssl_stapling_verify on;
resolver 223.5.5.5 119.29.29.29 valid=300s;
```

证书链必须包含中间证书（`fullchain.pem`），只给叶子证书会出现"部分安卓/Java 客户端提示证书无效"。

### 日志该记什么

默认的 `combined` 格式不含耗时拆解。建议加一个 upstream 计时：

```nginx
log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                '$status $body_bytes_sent "$http_referer" "$http_user_agent" '
                'rt=$request_time uct=$upstream_connect_time urt=$upstream_response_time '
                'ua=$upstream_addr rid=$request_id';
```

`urt` 是关键：`rt` 大但 `urt` 小，说明时间花在 Nginx 自己（限流、buffer、TLS）；两个都大，问题在后端。

### 限流放在 Nginx 还是应用

简单的防刷放 Nginx：

```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;
limit_req zone=api burst=40 nodelay;
limit_conn_zone $binary_remote_addr zone=conn:10m;
limit_conn conn 20;
```

`burst` 是允许的突发量，`nodelay` 表示突发也不排队直接放行。开了 `nodelay` 等于"平均限速 + 瞬时放行"，比排队更适合 API。

按用户维度限流（登录后的 `user_id`）只能放应用层，Nginx 看不到业务身份——这点别硬凑。

### 上线前的自查

```bash
nginx -t                      # 语法
nginx -T | grep -n proxy_pass # 确认改动生效
curl -I https://app.example.com/ -H 'Host: app.example.com'
openssl s_client -connect app.example.com:443 -servername app.example.com </dev/null | openssl x509 -noout -dates
```

改完别急着 `reload` 完就走，观察 5 分钟的 5xx 曲线再收工。
