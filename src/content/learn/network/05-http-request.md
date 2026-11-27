---
title: HTTP：一次请求长什么样
module: 进阶篇
summary: 请求行、头、正文三段结构，状态码归类，以及用 curl 自己发出一次请求看全程。
minutes: 20
---

### 浏览器替你做的那件事

打开网页，浏览器发出去的东西，本质就是一段纯文本：

```http
GET /index.html HTTP/1.1
Host: example.com
User-Agent: Mozilla/5.0
Accept: text/html

```

三部分：

1. **请求行**：方法 + 路径 + 协议版本
2. **请求头**：一堆 `键: 值`
3. **正文**：GET 通常没有，POST 才有

响应同理：

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Content-Length: 1024

<html>...
```

### 方法：动词

| 方法 | 用途 | 有正文 | 幂等 |
| --- | --- | --- | --- |
| GET | 取数据 | 否 | 是 |
| POST | 提交/创建 | 是 | 否 |
| PUT | 覆盖更新 | 是 | 是 |
| DELETE | 删除 | 可选 | 是 |
| HEAD | 只要头，不要正文 | 否 | 是 |

`HEAD` 很好用：`curl -I URL` 只拿响应头，检查状态码和 `Content-Type` 不用下载整个文件。

### 状态码：只有五类

| 段 | 含义 | 典型 |
| --- | --- | --- |
| 2xx | 成功 | `200` 正常、`204` 无内容 |
| 3xx | 重定向 | `301` 永久、`302` 临时、`304` 缓存未变 |
| 4xx | **客户端**的错 | `400` 参数错、`401` 未登录、`403` 无权限、`404` 不存在、`429` 请求太频 |
| 5xx | **服务端**的错 | `500` 程序崩、`502` 后端挂了、`503` 过载、`504` 后端超时 |

排错时这条分界线非常有用：**4xx 说明请求本身有问题（路径、权限、参数），5xx 说明服务器自己出了问题**。看到 404 去改服务器配置，方向就错了。

### 关键响应头

| 头 | 作用 |
| --- | --- |
| `Content-Type` | 是什么类型，`text/html` / `application/json` |
| `Content-Length` | 正文多大 |
| `Cache-Control` | 能缓存多久 |
| `Location` | 3xx 时跳去哪 |
| `Set-Cookie` | 让客户端存状态 |

### 用 curl 亲眼看一下

```bash
curl -I https://wild-think-lab.github.io/         # 只看头
curl -v https://wild-think-lab.github.io/         # 详细，含 TLS 握手
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" URL   # 只要状态码和耗时
```

`-w` 那行是最实用的"分阶段计时"起点。想知道慢在哪一步：

```bash
curl -o /dev/null -s -w "DNS %{time_namelookup} 连接 %{time_connect} TLS %{time_appconnect} 首字节 %{time_starttransfer} 总计 %{time_total}\n" URL
```

哪个时间戳突然变大，问题就在那一段。

### HTTPS 与 HTTP 的差别

HTTPS 是 HTTP 外面套了一层 TLS：先握手协商密钥，之后传输都加密。所以：

- 抓包时 HTTPS 内容是密文，只能看到域名和证书信息（这是设计目的，不是故障）。
- 证书过期 / 域名不匹配，浏览器直接拦住，报 `NET::ERR_CERT_*`。用 `curl -v` 能看到证书的具体错误。

### 自己验证

对任意一个站点跑三条：

```bash
curl -I 目标站点
curl -s -o /dev/null -w "%{http_code}\n" 目标站点/不存在的路径   # 期望 404
curl -o /dev/null -s -w "连接 %{time_connect} 首字节 %{time_starttransfer}\n" 目标站点
```

### 本章小结

- HTTP 报文就是纯文本三段：行、头、正文。
- 4xx 是自己的问题，5xx 是服务器的问题，别搞反。
- `curl -I` 看状态与类型，`curl -w` 量各阶段耗时。
- HTTPS 加密是正常设计，抓包看不到正文不是故障。

**下一章**：抓包——用 tcpdump 证明包到底到没到。
