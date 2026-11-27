---
title: curl 排障手册：把"接口不通"拆成五步
description: 十五个真正有用的 curl 参数、从 DNS 到 TLS 的验证顺序，以及五个"curl 通了但应用不通"的原因。
date: 2025-04-29
tags: [工具, curl, 排障]
---

### 五个阶段分离验证

```bash
# ① DNS
getent hosts api.example.com
# ② TCP 连通
curl -v telnet://api.example.com:443
# ③ TLS
curl -vI https://api.example.com
# ④ HTTP
curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' https://api.example.com/health
# ⑤ 业务
curl -sS -X POST https://api.example.com/api -H 'Content-Type: application/json' -d '{}'
```

**"分开验证"** 才能知道是哪一层出了问题。

### 十五个高频参数

```bash
-v                        # 详细（含请求/响应头）
-sS                       # 静默但显示错误
-o /dev/null -w '%{...}'   # 只要指标
-I                        # 只要响应头（HEAD）
-X POST                   # 方法
-H 'k: v'                 # 头
-d '{"a":1}'              # body（默认 JSON）
--data-binary @file       # 从文件读 body（保留换行）
--resolve host:443:1.2.3.4  # 绕过 DNS 指定 IP（测证书/后端）
--connect-timeout 3       # 连接超时
-m 10                     # 总超时
-L                        # 跟随重定向
-k                        # 忽略证书（仅调试）
--http2                   # 强制 HTTP/2
-x http://proxy:8080      # 走代理
```

**`--resolve`** 是最有用的调试参数：

```
域名不变，指向指定 IP → 能测"某个后端是否正常"，且 TLS SNI 正确
```

### 指标模板

```bash
curl -sS -o /dev/null -w \
'dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} code=%{http_code}\n' \
https://api.example.com
```

**判读**：

```
time_namelookup 大 → DNS 慢
time_connect - time_namelookup 大 → TCP 握手慢（网络/队列）
time_appconnect - time_connect 大 → TLS 握手慢（证书链/CPU）
time_starttransfer - time_appconnect 大 → 服务端处理慢
```

**"ttfb 大"** 才是应用问题，其他都是链路问题。

### 常见错误码对应

| 错误 | 含义 | 方向 |
| --- | --- | --- |
| Could not resolve host | DNS | DNS 配置/网络 |
| Connection refused | 端口没监听/防火墙 REJECT | 服务/防火墙 |
| Connection timed out | 丢包/防火墙 DROP | 网络/安全组 |
| SSL certificate problem | 证书链/时间 | 证书/时间同步 |
| Empty reply from server | 服务端断开（协议错/崩溃） | 应用/协议 |
| HTTP/2 stream error | 协议协商问题 | h2 配置/中间设备 |

**"Connection refused" 和 "timed out" 的差别很重要**：

```
refused → 有主机响应但端口不通（服务没起/防火墙 REJECT）
timed out → 完全没响应（丢包/DROP/路由错）
```

### 五个"curl 通了但应用不通"

**① 应用走了代理**

```
curl 直连成功，但应用配了 HTTP_PROXY → 走代理失败
```

```bash
env | grep -i proxy
```

**② 应用用的是 IPv6**

```
curl 默认可能走 v4，应用走 v6 → 目标没监听 v6
```

```bash
curl -6 https://api.example.com
```

**③ 应用只信任特定 CA**

```
curl 用系统 CA，应用用自己的 truststore → 证书校验失败
```

**④ 请求头/编码差异**

```
curl 发的是 UTF-8 JSON，应用发了 form-data
→ 服务端解析失败（400）
```

**⑤ MTU/大包**

```
小请求 OK，上传大文件失败
→ 用 `--limit-rate` 或 `-H 'Expect:'` 排查
```

### "TLS 握手慢"的排查

```bash
curl -vI https://api.example.com 2>&1 | grep -iE "SSL|TLS|certificate"
openssl s_client -connect api.example.com:443 -servername api.example.com </dev/null 2>&1 | grep -E "Verify|Protocol|Cipher"
```

**两个常见原因**：

```
① 证书链不全（缺中间证书）→ 客户端要去下载 → 慢/失败
② OCSP 校验超时
```

**"证书链不全"是最常见的问题**（浏览器能容忍，某些客户端不能）。

### 一个"一键体检"脚本

```bash
#!/usr/bin/env bash
url=$1
echo "== DNS ==";  getent hosts "${url#https://*/}" || echo FAIL
echo "== TLS ==";  curl -svI "$url" 2>&1 | grep -E "SSL connection|subject:|expire"
echo "== HTTP =="
curl -sS -o /dev/null -w 'code=%{http_code} ttfb=%{time_starttransfer} total=%{time_total}\n' "$url"
echo "== HTTP/2 =="; curl -sS --http2 -o /dev/null -w '%{http_version}\n' "$url"
```

### 检查清单

```
□ 会分五阶段验证（DNS/TCP/TLS/HTTP/业务）
□ 会用 -w 打指标
□ 会用 --resolve 测指定后端
□ 分清 refused 与 timeout
□ 会查代理环境变量
□ 会测 IPv6
□ 会用 openssl s_client 看证书链
□ 会看 ttfb 判断应用 vs 链路
□ 有大包/MTU 的排查手段
□ 有一个可复用的体检脚本
```
