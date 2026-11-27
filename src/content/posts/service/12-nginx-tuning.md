---
title: Nginx 性能与限流：把配置调到"刚好够用"
description: worker 与连接数、keepalive 与上游连接池、缓冲与代理优化、三档限流（连接/请求/带宽）、以及配置里最容易被忽略的六个参数。
date: 2026-11-27
tags: [Nginx, 性能, 限流, 反向代理]
---

### 先算清容量

```
最大并发 = worker_processes × worker_connections
```

```nginx
worker_processes auto;              # 等于 CPU 核数
events {
    worker_connections 10240;       # 每 worker 的连接数
    multi_accept on;
    use epoll;
}
```

注意：**一个代理连接占用两个连接**（客户端 + 上游）。所以 8 核 × 10240 ≈ 81920 连接，实际能承载的并发请求约 4 万。

不要盲调大：连接数越大，内存与 fd 消耗越大。

```bash
# 系统层也要放开
ulimit -n 65535
sysctl net.core.somaxconn=4096
sysctl net.ipv4.tcp_max_syn_backlog=4096
```

### 上游连接复用（最容易被忽略的性能点）

```nginx
upstream backend {
    server 10.0.0.11:8080;
    server 10.0.0.12:8080;
    keepalive 64;                   # 与上游保持 64 个空闲长连接
    keepalive_requests 1000;
    keepalive_timeout 60s;
}

location / {
    proxy_http_version 1.1;          # 必须 1.1 才支持 keepalive
    proxy_set_header Connection "";
    proxy_pass http://backend;
}
```

三条同时具备才生效：

1. `keepalive N`（上游连接池大小）。
2. `proxy_http_version 1.1`。
3. `proxy_set_header Connection ""`（清掉默认的 `close`）。

不做这三件事，Nginx 每个请求都新建到上游的 TCP 连接，**QPS 直接砍一半**。

### 缓冲与超时

```nginx
proxy_buffering on;
proxy_buffer_size 16k;
proxy_buffers 8 16k;
proxy_busy_buffers_size 32k;

proxy_connect_timeout 5s;
proxy_send_timeout 60s;
proxy_read_timeout 60s;
```

原则：

- **后端响应小、客户端慢** → 开缓冲（后端不被慢客户端拖住）。
- **流式/SSE/大文件下载** → 关缓冲（`proxy_buffering off`），否则客户端看不到实时数据。

```nginx
location /stream/ {
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

### 三档限流

**① 连接数限制（防慢速攻击）**

```nginx
limit_conn_zone $binary_remote_addr zone=perip:10m;
limit_conn perip 20;
```

**② 请求速率限制**

```nginx
limit_req_zone $binary_remote_addr zone=req:10m rate=10r/s;

location /api/ {
    limit_req zone=req burst=20 nodelay;
}
```

`burst=20` 允许突发 20 个，`nodelay` 表示突发部分立即处理（否则会排队，增加延迟）。

**③ 带宽限制**

```nginx
location /download/ {
    limit_rate 1m;          # 每连接 1MB/s
    limit_rate_after 10m;   # 前 10MB 不限速
}
```

三档的组合意义：

```
limit_conn   → 防"一个 IP 开一万个连接"
limit_req    → 防"一个 IP 每秒一万次请求"
limit_rate   → 防"一个连接把带宽占满"
```

只做其中一项，都能被绕过。

### 六个容易被忽略的参数

```nginx
# ① 客户端请求体大小（上传 413 的根因）
client_max_body_size 20m;

# ② 大 header（长 token 场景）
large_client_header_buffers 4 16k;

# ③ 长连接超时（Web 服务通常很短）
keepalive_timeout 30s;
keepalive_requests 1000;

# ④ 文件传输优化
sendfile on;
tcp_nopush on;
tcp_nodelay on;

# ⑤ 压缩（有 CPU 成本，静态资源交给 CDN 更好）
gzip on;
gzip_min_length 1k;
gzip_types text/css application/javascript application/json;

# ⑥ 优雅关闭，避免升级时丢请求
worker_shutdown_timeout 30s;
```

`sendfile + tcp_nopush` 是静态文件高吞吐的关键组合；`tcp_nodelay` 对小包低延迟有效——两者看似矛盾，Nginx 会自动在合适的场景切换。

### 可观测：三个必开日志字段

```nginx
log_format main '$remote_addr - $remote_user [$time_local] '
                '"$request" $status $body_bytes_sent '
                '"$http_referer" "$http_user_agent" '
                'rt=$request_time uct=$upstream_connect_time '
                'uht=$upstream_header_time urt=$upstream_response_time';
```

三个耗时字段的用途：

| 字段 | 含义 | 高值说明 |
| --- | --- | --- |
| `$request_time` | 从收到请求到发完响应 | 客户端慢或整体慢 |
| `$upstream_response_time` | 上游处理时间 | 后端慢 |
| `$upstream_connect_time` | 与上游建连时间 | 连接池没生效 / 上游过载 |

**`$request_time` 高但 `$upstream_response_time` 低**，说明慢在客户端侧（网络或客户端读取慢），不是后端问题。这个判断能省掉大量无效排查。

### 一个容量评估表

| 场景 | 建议配置 |
| --- | --- |
| 普通 Web 反代 | worker=CPU 核数，connections 10240，keepalive 64 |
| API 网关 | 同上 + limit_req 按租户 |
| 静态文件 | sendfile on，交给 CDN |
| 大文件下载 | proxy_buffering off，limit_rate 限速 |
| SSE/长轮询 | 关缓冲，超时拉长，连接数按在线用户估 |

### 排查：连接数异常增长

```bash
ss -s
ss -ant state established | wc -l
ss -ant state time-wait | wc -l
```

三种典型：

- **TIME_WAIT 很多** → 短连接多，检查 upstream keepalive 是否生效。
- **ESTABLISHED 持续上涨** → 客户端不关连接，或后端慢导致堆积。
- **SYN_RECV 多** → SYN flood 或 backlog 太小。

配合 Nginx 的 `stub_status`：

```nginx
location /nginx_status {
    stub_status;
    allow 127.0.0.1;
    deny all;
}
```

输出 Active connections / accepts / handled / requests，能直接看出"是不是连接泄漏"。
