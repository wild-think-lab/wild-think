---
title: TLS 1.3 与 HTTP/2、HTTP/3：线上到底该开哪些
description: 三个协议各自解决什么、TLS 1.3 的握手变化与兼容问题、HTTP/2 的实际收益、HTTP/3 的部署前提，以及"开了但没变快"的原因。
date: 2026-11-27
tags: [TLS, HTTP2, HTTP3, Nginx, 性能]
---

### 三者是不同层的东西

```
HTTP/1.1、HTTP/2、HTTP/3   应用层协议
TLS 1.2、1.3               传输层加密
```

可以自由组合（HTTP/3 必须基于 QUIC，不用 TLS 记录层）。

### TLS 1.3 变了什么

**握手从 2-RTT 变成 1-RTT**（会话恢复可 0-RTT）：

```
TLS 1.2：ClientHello → ServerHello/Cert → ClientKeyExchange → Finished（多次往返）
TLS 1.3：ClientHello → ServerHello + 证书 + Finished（一次往返）
```

同时**删掉了不安全的老算法**（RSA 密钥交换、RC4、3DES、SHA-1）。

配置：

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_session_cache shared:SSL:50m;
ssl_session_timeout 1d;
ssl_session_tickets off;      # 有隐私考量时关闭
```

**兼容性注意**：

- 老客户端（Android 4.x、IE11）只支持 TLS 1.2 及以下 → 保留 1.2。
- 部分老设备不支持 TLS 1.3 的 AEAD 套件 → 关掉 1.3 才能连（少见但存在）。

### HTTP/2 的收益与代价

**收益**：

- 多路复用：一个连接并发多个请求（不再受 6 连接限制）。
- 头部压缩（HPACK）。
- 服务端推送（已基本废弃，别用）。

**代价**：

- 单个连接承载所有请求，**一个慢响应会拖住其他**（队头阻塞仍在 TCP 层）。
- 服务端要处理更多并发流，内存开销上升。

```nginx
listen 443 ssl http2;
```

**"开了 HTTP/2 但没变快"的三个原因**：

1. 页面本来只有 3–5 个请求，多路复用收益小。
2. 服务端资源（CPU/带宽）才是瓶颈。
3. 用了域名分片（sharding）——那是 HTTP/1.1 的优化，与 HTTP/2 冲突。

### HTTP/3（QUIC）

**解决的是 TCP 层的队头阻塞**：QUIC 在 UDP 上实现可靠传输，丢包只影响那一个流。

部署前提：

```
① 客户端支持（现代浏览器都支持）
② 服务端支持（Nginx 1.25+ 需编译 quic 模块，或 Caddy/Envoy）
③ UDP 443 放通（很多防火墙只放 TCP）
```

Nginx 配置（1.25+）：

```nginx
listen 443 quic reuseport;
listen 443 ssl;
ssl_protocols TLSv1.3;                 # QUIC 必须 1.3
add_header Alt-Svc 'h3=":443"; ma=86400';
```

`Alt-Svc` 头的作用：告诉浏览器"我支持 h3，下次用 QUIC 来连"。**没有这个头，HTTP/3 不会生效**。

验证：

```bash
curl --http3 -I https://example.com
# 或浏览器开发者工具看 protocol 列是否 h3
```

### 该不该开：决策表

| 场景 | TLS | HTTP/2 | HTTP/3 |
| --- | --- | --- | --- |
| 内网 API | 1.2 + 1.3 | 开（收益小但无害） | 不必 |
| 公网 Web（大量小资源） | 1.3 优先 | **必开** | 建议开（移动网络收益明显） |
| 大文件下载 | 1.3 优先 | 开 | 开（弱网改善明显） |
| 老旧客户端兼容要求 | 保留 1.2 | 谨慎（可能有问题） | 关 |
| 服务到服务（内网） | 可选 mTLS | 开 | 一般不必 |

### 常见问题

**① 证书链不完整**

浏览器绿锁但部分客户端报错 → 缺中间证书。用 `fullchain.pem`。

```bash
openssl s_client -connect example.com:443 -servername example.com </dev/null 2>/dev/null | openssl verify
```

**② HSTS 把网站锁死**

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
```

一旦下发一年期 HSTS，证书出问题用户无法通过"继续访问"绕过。**第一次上线用小值（如 300 秒）验证**。

**③ 混合内容**

HTTPS 页面里引用了 `http://` 的资源，浏览器会拦截（图片可能直接不显示）。

```bash
# 检查页面里的 http 资源
curl -s https://example.com | grep -o 'http://[^"]*' | head
```

**④ OCSP 与证书吊销**

TLS 1.3 下 OCSP stapling 更依赖服务端配置：

```nginx
ssl_stapling on;
ssl_stapling_verify on;
resolver 223.5.5.5 8.8.8.8 valid=300s;
```

没有 `resolver` 时 stapling 会失败。

### 性能对比的实际量级

| 变化 | 典型收益 |
| --- | --- |
| TLS 1.2 → 1.3 | 握手少 1 RTT，首次连接快 50–200ms |
| HTTP/1.1 → HTTP/2 | 多资源页面加载快 10–30% |
| HTTP/2 → HTTP/3 | 弱网/移动端快 10–20%，有线网络差异小 |

结论：**HTTP/2 的收益最大且最稳**，TLS 1.3 是"顺手就开"，HTTP/3 在移动端收益明显。

### 检查清单

```
□ 只开 TLS 1.2 + 1.3，关闭老版本
□ 证书链完整（fullchain）
□ HSTS 从小 max-age 开始
□ HTTP/2 已开（Nginx listen ... http2）
□ 如需 HTTP/3：UDP 443 放通 + Alt-Svc 头
□ 无混合内容
□ 有证书到期告警
```
