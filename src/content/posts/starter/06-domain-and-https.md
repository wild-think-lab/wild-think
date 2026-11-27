---
title: 给自己的项目上域名与 HTTPS：备案、解析、证书、上线检查
description: 从买域名到 HTTPS 生效的完整顺序、备案到底卡在哪、DNS 解析的四种记录、证书三种获取方式，以及上线前必查的八项。
date: 2022-03-07
tags: [入门, 域名, HTTPS, 备案, 上线]
---

### 完整顺序

```
买域名 → 实名认证 → 备案（境内服务器必须）→ DNS 解析 → 服务器就绪
      → 申请证书 → 配 HTTPS → 强制跳转 → 上线检查
```

最容易出错的是把顺序搞反：**服务器没就绪就解析，解析没生效就调证书，证书没生效就发出去**。

### 备案：卡在哪

在境内（大陆）服务器上跑网站，需要 ICP 备案。

流程要点：

1. **域名实名认证**后才能备案（个人/企业证件要与主体一致）。
2. 备案必须通过**服务器提供商**提交（阿里云/腾讯云等有备案系统）。
3. 需要**网站负责人**信息、幕布拍照（部分省份）。
4. 审核周期：管局通常 7–20 个工作日。

三个坑：

- **域名注册人与备案主体不一致** → 驳回。
- **网站名称含"新闻/教育/医疗"等前置审批词** → 需要额外资质，否则驳回。
- **备案期间域名不能解析到未备案的服务器**，会被拦截。

不备案的后果：域名被阻断（80/443 直接不通），不是"罚款"，是"打不开"。

如果服务器在境外（香港、海外），不需要备案，但**国内访问延迟与稳定性会差**，且部分场景（小程序、公众号跳转）要求备案域名。

### DNS 解析：四种记录

| 类型 | 用途 | 例子 |
| --- | --- | --- |
| A | 域名 → IPv4 | `app.example.com → 1.2.3.4` |
| AAAA | 域名 → IPv6 | 同上，v6 地址 |
| CNAME | 别名 → 另一个域名 | `www → app.example.com`，或指向 CDN |
| TXT | 验证/策略 | 证书验证、SPF、DKIM |

常见配置：

```
@      A      1.2.3.4
www    CNAME  app.example.com
api    A      1.2.3.5
```

**CNAME 不能与 A 记录同名共存**（同一主机名的 CNAME 与 A 冲突），这是最常见的解析配置错误。

生效时间：TTL 决定。改解析前先把 TTL 调小（如 60 秒），改完再调回（如 600 秒），可以减少"改了但不生效"的等待。

验证：

```bash
dig +short app.example.com
dig +short NS example.com
dig +short TXT _acme-challenge.app.example.com
```

不要用本机 `ping` 判断解析是否生效——本机可能有 DNS 缓存。

### 证书：三种获取方式

**① Let's Encrypt（免费，90 天自动续）**

```bash
certbot --nginx -d app.example.com -d www.app.example.com
```

自动续期：

```bash
systemctl list-timers | grep certbot
certbot renew --dry-run      # 必须测一次
```

**② 商业证书（一年，含保险）**

适合对外商业站点（部分支付渠道要求）。注意**证书链要完整**（`fullchain.pem` 而不是 `cert.pem`），否则部分安卓/老客户端报"不受信任"。

**③ 云厂商托管证书**

在 CDN/负载均衡上传证书，后端用 HTTP。省事，但**后端到 LB 之间是明文**，内网也要考虑可信度。

验证证书链是否完整：

```bash
openssl s_client -connect app.example.com:443 -servername app.example.com </dev/null 2>/dev/null \
 | openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt
```

或用在线工具看"证书链是否完整"。

### Nginx 配置模板

```nginx
server {
    listen 80;
    server_name app.example.com www.app.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name app.example.com www.app.example.com;

    ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

三个注意：

1. **HSTS 要谨慎**：一旦下发 `max-age=31536000`，浏览器会记住一年内必须 HTTPS。证书出问题时用户连不上，且**无法回退**。第一次上线先用小 `max-age`。
2. `X-Forwarded-Proto` 必须传，否则后端生成的重定向链接会变成 `http://`。
3. `ssl_prefer_server_ciphers off` 在现代配置里是推荐值（让客户端选，交给 TLS1.3）。

### 上线前八项检查

```
□ 域名解析正确（A/CNAME 生效，dig 验证）
□ 80 → 443 跳转生效（curl -I http://... 应返回 301）
□ 证书链完整（openssl 验证，不只看浏览器绿锁）
□ TLS 版本 ≥1.2（openssl s_client -tls1 应失败）
□ 证书到期告警（剩余 <30 天通知）
□ 静态资源也走 HTTPS（避免混合内容）
□ 备份与回滚方案（旧证书/旧配置保留）
□ 访问日志与错误日志正常落盘
```

一键检查脚本：

```bash
#!/usr/bin/env bash
H=$1
echo "== 跳转 =="; curl -sI "http://$H" | head -1
echo "== 证书 =="; echo | openssl s_client -servername "$H" -connect "$H:443" 2>/dev/null \
  | openssl x509 -noout -dates -subject
echo "== TLS1.1 应失败 =="; echo | openssl s_client -tls1_1 -connect "$H:443" 2>&1 | grep -m1 -E 'alert|error'
echo "== HSTS =="; curl -sI "https://$H" | grep -i strict-transport
```

### 常见问题

| 现象 | 原因 |
| --- | --- |
| 浏览器报警但 curl 正常 | 证书链缺中间证书 |
| 部分手机打不开 | 只支持了 TLS1.3 或证书链问题 |
| 图片不显示 | 混合内容（http 资源嵌在 https 页面） |
| 域名解析生效但访问 404 | Host 头没对上 `server_name` |
| 备案被驳回 | 主体/名称/证件不一致 |

### 一句话总结

域名与 HTTPS 的难点不在技术，而在**顺序与细节**：先备案再解析、先证书链完整再上线、HSTS 从小值开始。这三点做对，就没有"上线当天打不开"这种事。
