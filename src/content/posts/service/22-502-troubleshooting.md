---
title: 一次 502 的完整追凶：从上游超时到内核 backlog
description: 502 不是"网关坏了"，是"它没拿到完整响应"。这篇把七种成因、判别方法和对症修法逐条拆开。
date: 2025-11-04
tags: [Nginx, 排错, 网络]
---

### 502 的真实含义

```
502 Bad Gateway = 网关向上游发起请求，但没拿到"完整的、合法的"响应
```

**注意**：它不等于"连不上"（那是 504 或 connection refused）。

**七种成因，按出现频率排序**：

```
① 上游进程重启/崩溃（最常见）
② 上游响应头前就断开（上游主动 reset）
③ 上游响应超时（proxy_read_timeout 太短）
④ 上游返回了非法 HTTP（协议不合法）
⑤ 请求体过大被上游拒绝（499/413 表现）
⑥ 内核 backlog 满（SYN 队列溢出）
⑦ keepalive 连接被上游关闭（复用了死连接）
```

### 判别流程

```bash
# 1. 看 Nginx 错误日志的具体措辞
tail -100 /var/log/nginx/error.log | grep -E "upstream|502"
```

**日志措辞直接对应成因（这是最有价值的一步）**：

| 日志 | 含义 | 方向 |
| --- | --- | --- |
| `upstream prematurely closed connection` | 上游提前断开 | 上游崩溃/重启 |
| `upstream timed out (110)` | 读超时 | timeout 设置或上游慢 |
| `no live upstreams` | 没可用后端 | 健康检查全挂 |
| `connect() failed (111: Connection refused)` | 连不上 | 端口没开/进程没起 |
| `recv() failed (104: Connection reset by peer)` | 被 reset | 上游处理时崩了 |
| `SSL_do_handshake() failed` | TLS 握手失败 | 证书/协议不匹配 |

**先读日志，再谈修复**。

### 成因一：上游在重启

**现象**：

```
发布窗口期间 502 集中出现，几分钟后自愈
```

**根因**：滚动发布时旧进程还在处理请求就被 kill。

**修法（按语言）**：

```
PHP-FPM ：graceful reload（kill -USR2），不要 restart
Java    ：先摘流量（从 upstream 移除），等连接排空再停
Go      ：监听 SIGTERM 后优雅关闭（Shutdown）
Node    ：同样处理 SIGTERM + server.close()
```

**Nginx 侧兜底**：

```nginx
upstream backend {
    server 10.0.0.1:8080 max_fails=3 fail_timeout=10s;
    server 10.0.0.2:8080 max_fails=3 fail_timeout=10s;
    keepalive 32;
}
```

**`max_fails` + `fail_timeout`** 让坏节点在窗口内被摘除，流量自动转移。

### 成因二：上游主动 reset（最常见于 PHP-FPM）

**日志**：

```
recv() failed (104: Connection reset by peer) while reading response header from upstream
```

**FPM 侧原因**：

```
① pm.max_children 打满 → 新请求被拒 → 连接被 reset
② request_terminate_timeout 到了 → FPM 杀 worker
③ 脚本 fatal error → worker 异常退出
```

**查证**：

```bash
# FPM 状态
curl http://127.0.0.1/status            # 需开启 pm.status_path
# 关注：active processes / listen queue / max children reached
```

**修法**：

```ini
; php-fpm.d/www.conf
pm = dynamic
pm.max_children = 50          ; 按内存算：可用内存 / 单进程内存
pm.start_servers = 10
pm.min_spare_servers = 5
pm.max_spare_servers = 20
pm.max_requests = 500         ; 防内存泄漏累积
request_terminate_timeout = 60s
```

**容量算法**：

```
pm.max_children ≈ 可用内存 / 单 PHP 进程平均占用
（用 ps 实测，通常 30–60MB）
```

### 成因三：读超时

**日志**：

```
upstream timed out (110: Connection timed out) while reading response header
```

**默认值陷阱**：

```
proxy_read_timeout 默认 60s
```

**如果上游有慢接口（如导出报表 3 分钟）**：

```nginx
location /export/ {
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

**注意**：不只是 Nginx，客户端、负载均衡、云厂商网关都有超时，要**逐层对齐**（取最短的那个为准）。

### 成因四：上游返回非法 HTTP

**日志**：

```
upstream sent invalid header: "..."
```

**常见原因**：

```
① 上游是"裸 TCP 服务"，返回的不是 HTTP
② 上游中间件插入了非法字符
③ 上游返回了 HTTP/0.9（无状态行）
```

**排查**：

```bash
# 直连上游看原始响应
curl -sv http://10.0.0.1:8080/ 2>&1 | head -30
# 或用 nc 看原始字节
printf 'GET / HTTP/1.0\r\n\r\n' | nc 10.0.0.1 8080 | head -20
```

### 成因五：请求体过大

**表现**：大文件上传时 502（不是 413）。

**Nginx 侧**：

```nginx
client_max_body_size 100m;
```

**上游侧**（同样要放开）：

```
PHP      ：upload_max_filesize / post_max_size
Java     ：spring.servlet.multipart.max-file-size
Node     ：body-parser limit
```

**只改 Nginx 不改上游，还是会在上游报错**。

### 成因六：内核 backlog 溢出（隐蔽但致命）

**现象**：

```
高并发时零星 502，且日志里有 "connect() failed" 或超时
ss -s 显示 SYN 队列溢出
```

**原理**：

```
三次握手时，连接先进入"半连接队列"（SYN queue）
再进入"全连接队列"（accept queue）
队列满 → 内核丢包或 reset → Nginx 表现为连不上上游
```

**查证**：

```bash
ss -s
# 关注 "SYNs to LISTEN sockets dropped"
netstat -s | grep -E "listen|overflow"
```

**修法**：

```bash
# 1. 全连接队列（listen backlog）
sysctl -w net.core.somaxconn=65535
# 同时 Nginx 的 listen backlog 要跟上
# listen 80 backlog=65535;

# 2. 半连接队列
sysctl -w net.ipv4.tcp_max_syn_backlog=8192

# 3. SYN cookies（极端情况下启用）
sysctl -w net.ipv4.tcp_syncookies=1

# 4. 临时端口范围（作为客户端时）
sysctl -w net.ipv4.ip_local_port_range="1024 65535"
```

**关键点**：**上游的 listen backlog 必须 ≥ Nginx 的并发连接数**，否则队列必满。

### 成因七：keepalive 复用了死连接

**现象**：

```
低频但持续出现 502，且集中在"空闲一段时间后的第一个请求"
```

**原理**：

```
Nginx 与上游保持 keepalive 连接
上游（或中间防火墙）在空闲 60s 后关闭了这个连接
Nginx 不知道，仍复用它发请求 → 被 reset
```

**修法**：

```nginx
upstream backend {
    server 10.0.0.1:8080;
    keepalive 32;
    keepalive_timeout 60s;     # 小于上游/防火墙的空闲超时
    keepalive_requests 1000;
}
```

**原则**：**Nginx 的 keepalive_timeout 要小于链路中间设备的空闲超时**（常见 60s，防火墙常设 300s，要确认）。

**另一个兜底**：

```nginx
proxy_next_upstream error timeout http_502 http_503;
proxy_next_upstream_tries 2;
```

**这个配置的意义**：遇到 502 自动重试另一个后端（幂等请求才安全）。

### 一个真实案例的完整链路

```
现象：每天 10:00 左右 502 高峰，持续 20 分钟

① 日志：recv() failed (104)
② FPM status：listen queue 100（满），max children reached
③ 系统：pm.max_children=20，内存 8G，单进程 50MB
④ 结论：max_children 严重不足（8G 能开 100+）
⑤ 改：max_children=100，start_servers=20
⑥ 复测：queue 归零，502 消失
```

**教训**：FPM 的 `max_children` 默认值（5）在真实流量下必然打满。

### 检查清单

```
□ 502 先读 error.log 的措辞（不要凭猜）
□ 发布用 graceful reload（SIGTERM/SIGUSR2）
□ upstream 配 max_fails/fail_timeout
□ upstream 配 keepalive + 合理的 keepalive_timeout
□ proxy_next_upstream 支持幂等重试
□ FPM max_children 按内存实算
□ 慢接口单独放 timeout
□ 上传大小三层（Nginx/PHP/框架）都放开
□ somaxconn 与 listen backlog 对齐
□ 监控 listen queue / syn drop
□ 各层超时对齐（取最短）
```
