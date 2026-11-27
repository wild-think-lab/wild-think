---
title: HTTP 速查
summary: 方法、状态码、关键头字段、缓存语义、连接复用与常见排障判断。
group: network
order: 5
tags: [HTTP, 网络, 排障]
---

### 方法

| 方法 | 语义 | 幂等 | 有请求体 |
| --- | --- | --- | --- |
| GET | 读取 | 是 | 否（不应有） |
| HEAD | 只要头 | 是 | 否 |
| POST | 创建/提交 | 否 | 是 |
| PUT | 全量替换 | 是 | 是 |
| PATCH | 部分更新 | 否 | 是 |
| DELETE | 删除 | 是 | 可选 |
| OPTIONS | 预检/能力 | 是 | 否 |

**"幂等"决定能不能安全重试**：

```
GET/PUT/DELETE 可重试
POST 重试可能重复创建 → 需要幂等键
```

### 状态码速查

```
1xx 信息：100 Continue、101 Switching Protocols
2xx 成功：200 OK、201 Created、202 Accepted、204 No Content、206 Partial Content
3xx 重定向：301 永久、302 临时、303 见其他、304 未修改、307/308 保持方法与体
4xx 客户端：
  400 请求错误  401 未认证  403 禁止  404 不存在
  405 方法不允许  408 超时  409 冲突  410 已删除
  413 体太大  414 URI 太长  415 类型不支持  418 我是茶壶
  429 限流过多
5xx 服务端：
  500 内部错误  501 未实现  502 网关错误
  503 不可用  504 网关超时  505 版本不支持
```

**最常被混淆的两组**：

```
401 vs 403：401 是"没认证"，403 是"认证了但没权限"
502 vs 504：502 是"后端给了非法/不完整响应"，504 是"后端超时"
```

### 关键头字段（请求侧）

```
Host              目标主机（HTTP/1.1 必须）
User-Agent        客户端标识
Accept            能接受的类型
Accept-Encoding   编码（gzip/br）
Accept-Language   语言
Authorization     认证（Bearer/Basic）
Cookie            会话
Content-Type      请求体类型（application/json 等）
Content-Length    体长度
If-None-Match     条件请求（配合 ETag）
If-Modified-Since 条件请求（配合 Last-Modified）
X-Forwarded-For   经过的代理链（真实 IP）
X-Request-Id      链路追踪
```

### 关键头字段（响应侧）

```
Content-Type        响应体类型（带 charset 时更明确）
Content-Length      长度
Content-Encoding    压缩方式
Cache-Control       缓存策略
ETag                内容指纹
Last-Modified       最后修改时间
Set-Cookie          下发 Cookie
Location            重定向目标（3xx 必带）
Retry-After         何时可重试（429/503）
Vary                缓存按哪些头区分
Strict-Transport-Security   强制 HTTPS
```

### 缓存语义

**Cache-Control 常用值**：

```
no-store        完全不缓存
no-cache        可存但每次要验证
private         只允许浏览器缓存
public          允许中间代理缓存
max-age=3600    缓存 1 小时
s-maxage=600    只对共享缓存生效
must-revalidate 过期后必须验证
immutable       内容永不变（配 hash 文件名）
```

**验证型缓存（304）**：

```
客户端带 If-None-Match: <etag>
服务端比对一致 → 返回 304（不带体）
→ 省带宽但仍有往返
```

**"immutable + 长 max-age"** 能让浏览器完全跳过请求（最强缓存）。

### 连接与协议

```
HTTP/1.0  每请求一个连接（短连接）
HTTP/1.1  默认 keep-alive，支持管道化（基本没人用）
HTTP/2    单连接多路复用（帧），头部压缩（HPACK），需要 TLS
HTTP/3    QUIC（UDP），解决队头阻塞与握手延迟
```

**HTTP/1.1 的队头阻塞**：

```
一个连接同时只能处理一个请求
→ 浏览器开 6 个连接绕过
```

**HTTP/2 的问题**：

```
TCP 层丢包 → 所有流都等 → "TCP 队头阻塞"
→ HTTP/3（QUIC）解决
```

### 一个请求的完整过程

```
① DNS 解析（可能命中缓存）
② TCP 握手（三次）
③ TLS 握手（1-RTT 或 0-RTT）
④ 发送请求
⑤ 服务端处理（可能经过多层代理）
⑥ 返回响应（可能压缩/分块）
⑦ 连接复用或关闭
```

**"首屏慢"要分清是"连接慢"还是"处理慢"**：

```bash
curl -w "dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n" -o /dev/null -s https://example.com
```

**这个 `-w` 模板是排障利器**。

### 常见排障判断

| 现象 | 可能原因 |
| --- | --- |
| 卡在 DNS | 递归 DNS 慢/不可达 |
| 卡在 connect | 目标端口不通/防火墙 |
| 卡在 tls | 证书/协议不匹配/SNI 问题 |
| ttfb 很长 | 服务端处理慢（不是网络） |
| total 很长但 ttfb 短 | 传输慢（带宽/大响应） |
| 偶发超时 | 连接池/keepalive 复用死连接 |

### 常用 curl 组合

```bash
# 只看头
curl -sI https://example.com

# 跟随重定向并显示过程
curl -sL -o /dev/null -w "%{http_code} %{url_effective}\n" https://example.com

# 指定方法与数据
curl -X POST -H "Content-Type: application/json" -d '{"a":1}' https://api/x

# 指定 Host（测虚拟主机）
curl -H "Host: api.example.com" http://10.0.0.5/

# 强制 HTTP/1.1 或 HTTP/2
curl --http1.1 / --http2

# 忽略证书（仅测试）
curl -k https://self-signed/

# 上传文件
curl -F "file=@a.png" https://api/upload
```

### 安全相关

```
① 敏感信息不放 URL（会进日志/Referer）
② 认证用 Authorization 头（不放 query）
③ Cookie 加 HttpOnly + Secure + SameSite
④ 大文件上传要限制 Content-Length
⑤ 服务端要校验 Content-Type（防伪造）
```

### 坑

```
① 301 会被浏览器永久缓存（调试时用 302）
② 304 不能带响应体（否则客户端行为异常）
③ Content-Length 与实际不符 → 客户端挂起或截断
④ 分块传输（Transfer-Encoding: chunked）时不能带 Content-Length
⑤ CORS 的预检（OPTIONS）失败 = 后续请求全失败
```
