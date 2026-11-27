---
title: HTTP/2 与 HTTP/3 到底快在哪（以及什么时候反而更慢）
description: 多路复用、头部压缩、QUIC/0-RTT 的实际收益，队头阻塞的真相，以及"开了 HTTP/2 没变快"的五个原因。
date: 2026-11-27
tags: [网络, HTTP, 性能]
---

### HTTP/1.1 的三个问题

```
① 每个 TCP 连接一次只能处理一个请求（串行）
② 浏览器对同域名并发连接数限制（通常 6 个）
③ 每次请求重复发送一堆头部（Cookie、UA，可能几百字节）
```

**对策（HTTP/1.1 时代）**：

```
- 域名分片（把静态资源放多个域名，突破 6 连接限制）
- 雪碧图/合并文件（减少请求数）
- 内联小资源
```

**这些都是"打补丁"**，每个补丁都带来新问题（域名多了 DNS 查询多、合并文件导致缓存粒度粗）。

### HTTP/2 解决了什么

**① 多路复用（Multiplexing）**

```
一个 TCP 连接上并发多个请求流（stream）
不需要域名分片，也不需要合并文件
```

效果：**减少了连接数，也减少了连接建立开销**（每次 TLS 握手约 2–3 个 RTT）。

**② 头部压缩（HPACK）**

```
静态表（61 个常见头部）+ 动态表（连接内共享）
→ 重复的头部后续只发索引
```

**③ 二进制分帧**

```
不再用文本行，改用二进制帧 → 解析更高效、更严格
```

**④ 服务器推送（Server Push）**

```
服务端可主动推送资源（如 CSS 依赖的字体）
```

**实际结论：Server Push 已基本被放弃**（浏览器支持撤了/收益不明显），别专门为它设计。

### HTTP/2 的隐患：TCP 层队头阻塞

```
TCP 保证字节有序 → 一个包丢了，后面所有包都要等重传
→ HTTP/2 的多路复用全挤在一条 TCP 上
→ 丢一个包，所有 stream 都卡住
```

**这是 HTTP/2 在弱网下反而更慢的根本原因**：HTTP/1.1 有 6 条连接，丢一条还有其他 5 条在跑；HTTP/2 只有一条，全卡。

### HTTP/3 = HTTP/2 over QUIC

**QUIC 的关键改动**：

```
① 基于 UDP（不是 TCP）
② 每个 stream 独立重传（一个流丢包不影响其他流）
③ 0-RTT 握手（复用会话时省掉握手）
④ 内置 TLS 1.3（没有明文阶段）
```

**收益最大化的场景**：

```
- 高延迟链路（跨国、移动网络）
- 弱网/丢包率高（4G/5G 边缘、卫星）
- 首次连接后的复用（0-RTT）
```

**收益不明显的场景**：

```
- 内网/同机房（RTT 本来就低）
- 丢包率低（TCP 阻塞不常见）
```

### "开了 HTTP/2 没变快"的五个原因

**① 你的瓶颈不在协议**

```
查：是不是后端接口慢（TTFB 高）
协议优化只改善"传输"，不改善"处理"
```

**② 静态资源还是很多小请求**

```
HTTP/2 消除了连接限制，但没消除"请求数"
→ 每个请求还有自己的开销（首字节处理、TLS 无关、但服务端逻辑相关）
→ 该合并的还是要合并、该缓存的还是要缓存
```

**③ 没有开启 TLS 会话复用**

```
每次新连接都要完整握手（TLS 1.2 要 2 RTT）
→ 开启 session tickets / session cache
```

**④ CDN 未支持 HTTP/2（或回源走 1.1）**

```
客户端 ↔ CDN 是 h2，CDN ↔ 源站是 1.1
→ 收益被削掉一半
```

**⑤ 用了 HTTP/1.1 时代的优化（域名分片）**

```
HTTP/2 下域名分片反而有害：多个域名 = 多条连接 = 多次握手
→ 减少域名，把资源集中
```

### 怎么验证是不是真在用 h2/h3

```bash
# HTTP/2
curl -sI --http2 https://example.com/ | head -1
# 返回 HTTP/2 200

# HTTP/3（需要 curl 支持）
curl -sI --http3 https://example.com/ | head -1
# 返回 HTTP/3 200
```

浏览器 DevTools：

```
Network 面板 → 右键表头 → 勾选 Protocol
看到 h2 / h3 就是生效了
```

### Nginx 开启 HTTP/2

```nginx
server {
    listen 443 ssl;
    http2 on;                      # 1.25.1+ 的新语法

    ssl_certificate     /etc/ssl/certs/example.crt;
    ssl_certificate_key /etc/ssl/private/example.key;

    # TLS 1.3 才支持 0-RTT（HTTP/2 下不建议开 0-RTT 写请求）
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
}
```

**注意**：

```
① h2 只跑在 TLS 上（浏览器不支持 h2c 明文）
② 别在同一个 server 上同时 listen 80 和 443 再开 http2
③ http2 与 http2_push 已在新版移除
```

### HTTP/3 的现实情况

```
① 需要 Nginx/其他反代支持（Nginx 需第三方模块，商业版原生支持）
② CDN 通常已支持（Cloudflare/阿里云/腾讯云都支持）
③ 客户端支持良好（Chrome/Firefox/Safari 都支持）
④ 需要 UDP 443 在防火墙放通（很多企业网络封 UDP）
```

**务实做法**：

```
对外站点 → 交给 CDN 开 h3（自己配太麻烦）
内网站点 → 用 h2 足够
```

### 什么时候反而应该关掉 h2

```
① 后端只支持 1.1 且有大量小请求（转换开销）
② 中间设备（老防火墙/WAF）对 h2 支持差，会截断
③ 排障困难（h2 的抓包分析不如 1.1 直观）
```

**排查问题时临时降级到 1.1 是常规手段**。

### 性能对比思路（怎么自己测）

```bash
# 同一站点，强制 1.1 与 h2 对比
curl -s -o /dev/null -w '%{http_version} %{time_total}\n' --http1.1 https://example.com/
curl -s -o /dev/null -w '%{http_version} %{time_total}\n' --http2   https://example.com/
```

**但 curl 单请求测不出多路复用收益**。要测"页面加载"，用浏览器 DevTools 或 `wrk`：

```bash
wrk -t4 -c100 -d30s --latency https://example.com/
```

**注意**：wrk 对 h2 支持有限，专业压测用 `h2load`（nghttp2 工具包）。

```bash
h2load -n 1000 -c 100 https://example.com/
```

### 检查清单

```
□ 对外站点确认在用 h2/h3（DevTools Protocol 列）
□ TLS 会话复用已开（session cache / tickets）
□ 去掉了域名分片与过度合并
□ CDN 回源也是 h2（不只看边缘）
□ 弱网场景优先考虑 h3
□ 企业网络策略允许 UDP 443（否则 h3 不可用）
□ 排障时可临时降级到 1.1 对比
□ 用 h2load 而不是 wrk 压 h2
```
