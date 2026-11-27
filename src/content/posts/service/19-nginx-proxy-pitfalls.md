---
title: Nginx 反向代理的十个坑（都是上线后才发现的）
description: 真实代理问题的十个高频坑：Host 头、真实 IP、缓冲、超时、gzip、连接复用、大文件、WebSocket、错误页与日志。
date: 2025-04-20
tags: [Nginx, 反向代理, 排错]
---

### 坑 1：后端拿到的 Host 是错的

```nginx
# 默认：Host 头被改成上游地址（部分情况下）
proxy_pass http://backend;

# 正确：把原 Host 传下去
proxy_set_header Host $host;

# 如果后端按域名区分，还要传端口
proxy_set_header Host $host:$server_port;
```

**症状**：后端生成的绝对链接（如邮件里的链接、重定向）指向内网地址。

**注意 `$host` 与 `$http_host` 的区别**：

```
$host            优先取 Host 头的域名部分，没有则用 server_name
$http_host       原样取 Host 头（含端口）
$proxy_host      上游地址（proxy_pass 里的）
```

### 坑 2：真实客户端 IP 全是 127.0.0.1

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

**但要小心伪造**：`$proxy_add_x_forwarded_for` 会追加，客户端可以自己先塞一个假的。

安全做法（只信任自己的代理链）：

```nginx
# 只有来自可信代理的请求才采信 XFF
set_real_ip_from 10.0.0.0/8;
real_ip_header X-Forwarded-For;
real_ip_recursive on;
```

然后日志与业务都用 `$remote_addr`（已被 realip 模块修正）。

### 坑 3：POST 请求偶发 502

**根因**：`proxy_buffering` 与大请求体。

```
Nginx 默认先把请求体完整读进来（client_max_body_size 限制）
再把响应缓冲后发给客户端
```

大文件上传时的症状：

```
413 Request Entity Too Large   → client_max_body_size 太小
502                            → 上游等太久超时
```

```nginx
client_max_body_size 100m;
client_body_buffer_size 128k;      # 超过就写临时文件
proxy_request_buffering off;        # 流式转发（上传大文件必开）
```

**`proxy_request_buffering off`** 让 Nginx 边收边转，不再等整个文件。

### 坑 4：超时链没对齐

```nginx
proxy_connect_timeout 5s;
proxy_send_timeout 60s;
proxy_read_timeout 60s;
send_timeout 60s;
```

**关键原则：上游超时要小于客户端超时**，否则会出现"客户端已经放弃，Nginx 还在等上游"。

```
常见链条：
浏览器(30s) > Nginx(60s?) ✗ 反了
正确：浏览器(120s) >= Nginx proxy_read_timeout(60s) >= 应用(30s) >= DB(10s)
```

**越靠下游，超时应该越短**。

### 坑 5：gzip 压了但没生效

```nginx
gzip on;
gzip_types text/plain text/css application/json application/javascript;
gzip_min_length 1024;
gzip_vary on;

# 不要对已压缩的内容再压
gzip_disable "msie6";
```

**注意**：

```
① gzip_types 默认只含 text/html，其他类型要显式加
② 图片/视频不要加（已经压缩过）
③ 代理场景下，如果上游已经 gzip，Nginx 不会再压
```

验证：

```bash
curl -H 'Accept-Encoding: gzip' -I https://example.com/ | grep -i content-encoding
```

### 坑 6：上游连接不复用（性能杀手）

```nginx
upstream backend {
    server 10.0.0.1:8080;
    keepalive 32;                      # 每个 worker 保持 32 个空闲连接
    keepalive_timeout 60s;
}

server {
    location / {
        proxy_pass http://backend;
        proxy_http_version 1.1;             # 必须 1.1
        proxy_set_header Connection "";      # 清掉 close
    }
}
```

**`proxy_http_version 1.1` + `Connection ""`** 是复用的必要条件，缺一个都不生效。

效果：高并发下后端看到的 TIME_WAIT 大幅减少。

### 坑 7：大文件下载内存暴涨

```nginx
location /download/ {
    proxy_buffering off;               # 不缓冲整个响应
    proxy_max_temp_file_size 0;        # 或限制临时文件大小
    sendfile on;
}
```

**默认 `proxy_buffering on`** 会把大响应先写磁盘（`proxy_temp_path`），磁盘慢时会成为瓶颈。

**取舍**：关闭缓冲会降低客户端慢时的保护，但对大文件是必要的。

### 坑 8：WebSocket 连不上

```nginx
location /ws/ {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;          # 长连接要放宽
}
```

**症状**：握手 101 但没有数据流 / 60 秒后断开。

**60 秒断开** 通常就是 `proxy_read_timeout` 默认 60s 导致。

### 坑 9：错误页把 JSON 接口搞坏了

```nginx
error_page 502 503 504 /50x.html;

# 但 API 请求应该返回 JSON
location /api/ {
    proxy_intercept_errors off;        # 不要拦截上游的错误
}
```

**`proxy_intercept_errors on`** 会把上游的 4xx/5xx 替换成 Nginx 错误页 → 客户端收到 HTML 而非 JSON。

### 坑 10：日志里看不出问题

```nginx
log_format main '$remote_addr - $request_id [$time_local] '
                '"$request" $status $body_bytes_sent '
                '"$http_referer" "$http_user_agent" '
                'rt=$request_time uct=$upstream_connect_time '
                'uht=$upstream_header_time urt=$upstream_response_time';

access_log /var/log/nginx/access.log main;
```

**四个时间字段的意义**：

```
$request_time           整个请求（含客户端传输）
$upstream_connect_time  与上游建连耗时
$upstream_header_time   上游返回首字节耗时
$upstream_response_time 上游完整响应耗时
```

排"慢"的时候先看是哪一段慢：

```
connect 慢 → 网络/上游 accept 队列满
header 慢  → 应用处理慢
response 慢 → 响应体传输慢
request 慢而 upstream 快 → 客户端慢（网络）
```

`$request_id` 用来串联链路（透传给上游，日志对齐）。

### 附：一份基础可用的配置

```nginx
upstream app {
    server 10.0.0.1:8080;
    keepalive 32;
    keepalive_timeout 60s;
}

server {
    listen 80;
    server_name app.example.com;

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

        proxy_buffering on;
        proxy_buffers 8 16k;
        proxy_buffer_size 32k;
    }

    location /ws/ {
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

### 检查清单

```
□ proxy_set_header Host $host
□ X-Real-IP / X-Forwarded-For / X-Forwarded-Proto
□ real_ip 只信任可信代理段
□ client_max_body_size 按业务设
□ 大文件上传 proxy_request_buffering off
□ 超时链：浏览器 > Nginx > 应用 > DB
□ gzip_types 显式列出
□ 上游 keepalive + HTTP/1.1 + Connection ""
□ 大文件下载 proxy_buffering off
□ WebSocket 有 Upgrade/Connection + 长 timeout
□ API 路径 proxy_intercept_errors off
□ 日志含四个 upstream 时间与 request_id
```
