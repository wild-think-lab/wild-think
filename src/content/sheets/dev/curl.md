---
title: curl 与 HTTP 调试速查
summary: 请求构造、响应只看想要的字段、耗时拆解、上传下载与断点续传、代理与证书，一页解决接口对接问题。
group: 开发
order: 2
tags: [curl, http, 调试, 接口]
---

## 一、最常用的六个

```bash
curl -i https://api.example.com/health              # 带头部的响应
curl -s https://api.example.com/health | jq         # 静默 + 格式化 JSON
curl -I https://example.com                        # 只要头（HEAD）
curl -v https://example.com                        # 完整握手过程
curl -L https://example.com                        # 跟随重定向
curl -o out.json https://api.example.com/data      # 存文件
```

## 二、构造请求

```bash
# JSON POST
curl -X POST https://api.example.com/users \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer $TOKEN' \
  -d '{"name":"alice","age":30}'

# 表单
curl -X POST https://api.example.com/login \
  -d 'user=alice' -d 'pass=secret'

# 上传文件（multipart）
curl -X POST https://api.example.com/upload -F 'file=@./a.png' -F 'name=pic'

# 其他方法
curl -X PUT ... ; curl -X DELETE ... ; curl -X PATCH ...

# 查询参数（会自动 URL 编码）
curl -G https://api.example.com/search --data-urlencode 'q=中文 空格'

# 自定义 header / 伪装 UA
curl -H 'User-Agent: Mozilla/5.0' -H 'X-Trace-Id: abc123' https://example.com
```

**别忘记**：`-d` 默认用 `application/x-www-form-urlencoded`，发 JSON 必须显式 `-H 'Content-Type: application/json'`。

## 三、只看想要的部分

```bash
# 只取响应头
curl -s -D - -o /dev/null https://example.com

# 只看状态码
curl -s -o /dev/null -w '%{http_code}\n' https://example.com

# 提取 JSON 字段
curl -s https://api.example.com/users | jq -r '.[].name'
curl -s https://api.example.com/users | jq '.[] | select(.age > 25)'

# 只留 body（-s 静默 + -o /dev/null 丢 body）
curl -s -o /dev/null -w 'code=%{http_code} time=%{time_total}\n' https://example.com
```

## 四、耗时拆解（排"慢"）

```bash
curl -s -o /dev/null -w '
dns:      %{time_namelookup}
tcp:      %{time_connect}
tls:      %{time_appconnect}
ttfb:     %{time_starttransfer}
total:    %{time_total}
size:     %{size_download}
speed:    %{speed_download}
http:     %{http_code}
' https://example.com
```

判读：

| 现象 | 含义 |
| --- | --- |
| `dns` 大 | DNS 解析慢（换 DNS 或加缓存） |
| `tcp - dns` 大 | 网络 RTT 高（跨地域/丢包） |
| `tls - tcp` 大 | TLS 握手慢（证书链大、CPU 弱） |
| `ttfb - tls` 大 | **后端处理慢**（最该查的地方） |
| `total - ttfb` 大 | 响应体大或带宽小 |

## 五、下载与断点续传

```bash
curl -O https://example.com/big.iso                       # 用远端的文件名
curl -C - -O https://example.com/big.iso                  # 续传
curl -o big.iso --limit-rate 2M https://example.com/big.iso  # 限速
curl -r 0-1023 https://example.com/big.iso                # Range 请求
```

## 六、代理、证书、认证

```bash
# 代理
curl -x http://127.0.0.1:7890 https://example.com
curl --socks5-hostname 127.0.0.1:1080 https://example.com

# 忽略证书（仅测试！）
curl -k https://self-signed.example.com

# 指定客户端证书（双向 TLS）
curl --cert client.pem --key client.key https://example.com/mtls

# Basic Auth
curl -u user:pass https://example.com

# 用 cookie
curl -b 'session=abc' https://example.com
curl -c cookies.txt -b cookies.txt https://example.com   # 保存并复用
```

## 七、压测与并发（轻量）

```bash
# 顺序发 100 次，统计总耗时
for i in $(seq 100); do curl -s -o /dev/null https://example.com; done

# xargs 并发 10
seq 100 | xargs -P 10 -I{} curl -s -o /dev/null -w '%{http_code}\n' https://example.com

# 真实压测用 ab / wrk
wrk -t4 -c100 -d30s https://example.com
```

## 八、排障常用组合

```bash
# 1. 接口是否通 + 状态码 + 耗时
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' https://api.example.com/health

# 2. 看服务端返回的错误信息
curl -s https://api.example.com/x | jq '.error, .message'

# 3. 跟踪重定向链
curl -sIL https://example.com | grep -E 'HTTP/|Location'

# 4. 检查压缩是否开启
curl -sI -H 'Accept-Encoding: gzip, br' https://example.com | grep -i content-encoding

# 5. 检查 HTTP/2、HTTP/3
curl -sI --http2 https://example.com | head -1
curl -sI --http3 https://example.com | head -1

# 6. 用外部 DNS 判断是否本地 DNS 问题
curl --doh-url https://dns.alidns.com/dns-query https://example.com
```

## 九、jq 常用（配合 curl）

```bash
| jq '.'                          # 全量格式化
| jq -r '.data[].id'              # 原样输出（不带引号）
| jq 'keys'                       # 看有哪些字段
| jq 'length'                     # 数组长度
| jq '.[] | {name, age}'          # 构造新对象
| jq 'map(select(.status=="ok"))' # 过滤
| jq --arg v "$SHELL_VAR" '.[] | select(.name==$v)'
```
