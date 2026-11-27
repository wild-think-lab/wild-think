---
title: Nginx 配置调优：从默认参数到"能扛住一次秒杀"
description: worker 数、连接数、buffer、超时、静态缓存、gzip/brotli、以及六个必须改的默认值。
date: 2026-11-27
tags: [Nginx, 性能, 调优]
---

### 六个必须改的默认值

```nginx
worker_processes auto;              # 按 CPU 核数（默认 1）
worker_rlimit_nofile 65535;         # 文件描述符上限
events {
    worker_connections 65535;       # 默认 512
    multi_accept on;                # 一次 accept 多个连接
    use epoll;                      # Linux 最佳
}

http {
    sendfile on;                    # 零拷贝
    tcp_nopush on;                  # 配合 sendfile 减少小包
    tcp_nodelay on;                 # 长连接下减少延迟
    keepalive_timeout 65s;          # 默认 75s
    client_max_body_size 20m;       # 默认 1m（上传会 413）
}
```

**`worker_connections` 不够，高并发时 Nginx 直接报 `too many open files`**。

### 并发上限的计算

```
最大并发 ≈ worker_processes × worker_connections
最少要保证：> 预期的峰值连接数 × 1.2
```

**但别忘了系统级限制**：

```bash
ulimit -n            # 进程级
sysctl net.core.somaxconn   # 队列
```

```bash
# 提高系统限制
echo "nginx soft nofile 65535" >> /etc/security/limits.d/nginx.conf
echo "nginx hard nofile 65535" >> /etc/security/limits.d/nginx.conf
```

**这是最常见的"配置改了但还是报错"的原因**：忘了 ulimit。

### buffer 与超时（最容易被忽略的一组）

```nginx
# 与客户端之间的 buffer
client_body_buffer_size 16k;
client_header_buffer_size 4k;
large_client_header_buffers 4 16k;

# 与上游之间的 buffer
proxy_buffer_size 8k;
proxy_buffers 8 16k;
proxy_busy_buffers_size 32k;
proxy_temp_file_write_size 64k;
```

**`proxy_buffering` 的取舍**：

```
on（默认）：Nginx 先缓存上游响应再慢慢发给客户端
          → 上游更快释放，适合大响应
off       ：收到多少就转发多少（流式，适合 SSE/大文件下载）
```

**SSE / WebSocket / 大文件下载必须关 buffering**：

```nginx
location /events {
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

**不关的话，SSE 客户端会"等到有足够数据才收到"**，看起来像卡住。

### 超时链要对齐

```nginx
client_body_timeout 30s;    # 读客户端请求体的超时
client_header_timeout 30s;  # 读请求头的超时
send_timeout 30s;           # 向客户端发送的超时
proxy_connect_timeout 5s;   # 连上游
proxy_send_timeout 60s;
proxy_read_timeout 60s;
keepalive_timeout 65s;
```

**原则**：

```
proxy_connect_timeout 要短（连接失败应快速失败，5s 内）
proxy_read_timeout 按业务（默认 60s，慢接口单独调）
各层超时要小于"客户端自己的超时"，否则客户端先断
```

### 静态资源加速

```nginx
location ~* \.(jpg|jpeg|png|gif|ico|css|js|woff2)$ {
    root /data/static;
    expires 30d;
    add_header Cache-Control "public, immutable";
    access_log off;
    etag on;
    if_modified_since exact;
}
```

**`immutable` 的意义**：

```
带上 hash 的静态资源，永不变更 → 浏览器不用再发条件请求
→ 直接省掉 304 往返
```

**前提**：文件名带内容 hash（如 `app.a1b2c3.js`）。

### gzip 与 brotli

```nginx
gzip on;
gzip_comp_level 5;              # 4–6 是性价比区间（9 太耗 CPU）
gzip_min_length 1024;           # 太小的不压（压缩比低）
gzip_types text/plain text/css application/json application/javascript
           application/xml image/svg+xml;
gzip_vary on;                   # 加 Vary: Accept-Encoding
gzip_static on;                 # 有 .gz 文件直接发（省 CPU）
```

**注意**：

```
① 已压缩的格式（jpg/png/mp4/woff2）不要再 gzip（反而变大）
② 动态压缩耗 CPU，高 QPS 时优先用 gzip_static（预压缩）
③ brotli 需要模块（官方镜像默认不带）
```

**`gzip_static` 的用法**：

```bash
# 构建时预压缩
gzip -9 -k app.js    # 生成 app.js.gz
```

### 限流与并发控制

```nginx
# 限速（按 IP）
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req zone=api burst=20 nodelay;

# 限并发
limit_conn_zone $binary_remote_addr zone=conn:10m;
limit_conn conn 20;

# 限速（按连接带宽）
limit_rate 512k;
```

**`burst` 与 `nodelay` 的区别**：

```
burst=20        ：允许突发 20 个（多的排队，延迟处理）
burst=20 nodelay：允许突发 20 个且立即处理（超出直接拒）
```

**秒杀场景**：`nodelay` 更合适（快速拒绝而不是排队堆积）。

### 缓存（proxy_cache）

```nginx
proxy_cache_path /data/cache levels=1:2 keys_zone=api_cache:100m
                 max_size=10g inactive=60m use_temp_path=off;

location /api/ {
    proxy_cache api_cache;
    proxy_cache_valid 200 302 10m;
    proxy_cache_valid 404 1m;
    proxy_cache_key "$scheme$host$request_uri";
    proxy_cache_use_stale error timeout updating http_500 http_502;
    proxy_cache_lock on;                  # 同一 key 只回源一次
    add_header X-Cache-Status $upstream_cache_status;
}
```

**`proxy_cache_lock` 是"缓存击穿"的经典解法**：并发请求同一 key 时，只允许一个回源，其余等待。

### worker 与 CPU 亲和

```nginx
worker_processes auto;
worker_cpu_affinity auto;    # 8.0+ 支持
```

**老版本**：

```nginx
worker_processes 4;
worker_cpu_affinity 0001 0010 0100 1000;
```

**收益**：减少上下文切换与缓存失效（在超高 QPS 下可测出 5–10% 提升）。

### 日志开销

```nginx
access_log /var/log/nginx/access.log main buffer=64k flush=5s;
# 静态资源关日志
location ~* \.(css|js|png|jpg)$ { access_log off; }
```

**`buffer`** 让 Nginx 攒批写，减少 IO；**关静态日志**能省大量磁盘。

**日志格式也要精简**：

```nginx
log_format main '$remote_addr - $status $request_time "$request"';
```

### SSL/TLS 调优

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:...';
ssl_prefer_server_ciphers on;
ssl_session_cache shared:SSL:50m;
ssl_session_timeout 1d;
ssl_session_tickets off;
```

**关键点**：

```
① 只留 TLS1.2/1.3（1.0/1.1 已不安全）
② 启用 session cache（减少握手）
③ HTTP/2 需要 TLS（h2）
④ OCSP stapling 可减少握手往返
```

### 一个基准：压测后才谈调优

```bash
# 用 wrk
wrk -t4 -c400 -d30s http://127.0.0.1/
```

**没有基线数据的"调优"是玄学**。先测 QPS/延迟，再改参数，再测。

### 检查清单

```
□ worker_processes auto
□ worker_connections 与 ulimit 对齐
□ sendfile + tcp_nopush + tcp_nodelay
□ client_max_body_size 按业务调
□ buffer 大小合适（大响应或流式要区分）
□ SSE/WebSocket 关 buffering
□ 各层超时对齐且合理
□ 静态资源 expires + immutable
□ gzip 只压文本类，且用 gzip_static
□ 有限流/限并发
□ proxy_cache + cache_lock（防击穿）
□ 日志开 buffer，静态资源关日志
□ TLS 只留 1.2/1.3 + session cache
□ 有压测基线，改完复测
```
