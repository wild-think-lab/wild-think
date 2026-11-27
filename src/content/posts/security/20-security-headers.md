---
title: 安全响应头：五个 header 挡住一大半低级攻击
description: CSP、HSTS、X-Frame-Options、Referrer-Policy、Permissions-Policy 的配置、验证与踩坑。
date: 2025-06-24
tags: [安全, Web安全, HTTP]
---

### 成本最低的一层防线

```
改几行配置 → 挡住点击劫持、部分 XSS、协议降级、信息泄露
```

**"上线前没配响应头"是最常见的疏漏**。

### 五个必备 header

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Content-Security-Policy "default-src 'self'; ..." always;
```

---

**① HSTS（强制 HTTPS）**

```
max-age=31536000          一年内浏览器只用 HTTPS
includeSubDomains         所有子域也强制
preload                   申请加入浏览器预置列表（需谨慎）
```

**注意**：

```
① 上线前确认所有子域都支持 HTTPS（否则会把子域打死）
② max-age 先用小的（如 300）验证，再调大
③ 一旦浏览器记住，回滚要等 max-age 过期
```

**"直接上 preload"是高危操作**。

---

**② X-Content-Type-Options: nosniff**

```
禁止浏览器"猜"内容类型
→ 防"上传一个 .jpg 实际是 HTML/脚本"被当脚本执行
```

**这是最便宜、最该配的一个**。

---

**③ X-Frame-Options / frame-ancestors**

```
DENY                 不允许任何页面嵌套
SAMEORIGIN           只允许同源嵌套
ALLOW-FROM uri       指定来源（已废弃，兼容性差）
```

**现代做法**：用 CSP 的 `frame-ancestors`（更细粒度）

```
Content-Security-Policy: frame-ancestors 'self' https://trusted.example.com;
```

**作用**：防点击劫持（把银行页面透明叠在你的页面上，骗用户点击）。

---

**④ Referrer-Policy**

```
no-referrer                          完全不发 Referer
same-origin                          只同源发
strict-origin-when-cross-origin      同源发全路径，跨源只发 origin（推荐）
no-referrer-when-downgrade           降级时不发（默认行为，不够安全）
```

**为什么要管**：

```
URL 里可能有 token/参数 → Referer 泄露到第三方
外部图片/统计服务都能拿到 Referer
```

**推荐**：`strict-origin-when-cross-origin`。

---

**⑤ Content-Security-Policy（最难但最强）**

**一个可用的起点**：

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://cdn.example.com;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  font-src 'self' https://fonts.example.com;
  connect-src 'self' https://api.example.com;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  object-src 'none';
```

**逐项解释**：

```
default-src      ：兜底（其他没写的都按这个）
script-src       ：脚本来源（XSS 的主要防线）
style-src        ：样式（'unsafe-inline' 常见妥协）
img-src          ：图片
connect-src      ：fetch/XHR/WebSocket
frame-ancestors  ：谁能嵌我
base-uri         ：<base> 标签限制（防 base 劫持）
form-action      ：表单能提交到哪
object-src       ：禁止 Flash/插件（直接 none）
```

**先"报告模式"再"强制模式"**：

```
Content-Security-Policy-Report-Only: default-src 'self'; ... ; report-uri /csp-report
```

**观察一周的报告**，把误拦的合法来源加入白名单，再切到强制模式。

**"直接上严格 CSP 把线上打挂"是经典事故**。

### 五个常见 CSP 坑

**① `'unsafe-inline'` 让 CSP 形同虚设**

```
script-src 'unsafe-inline' → 行内脚本可执行 → XSS 依然成功
```

**改用 nonce/hash**：

```
Content-Security-Policy: script-src 'nonce-abc123' 'strict-dynamic';
```

```html
<script nonce="abc123">...</script>
```

**`nonce` 必须每次请求随机**（由服务端生成）。

**② `'strict-dynamic'` 的行为惯性**

```
开启后，'self' 与白名单会被忽略（只认 nonce/hash）
→ 老代码里靠白名单的脚本会突然挂
```

**③ 第三方 SDK 加不进来**

```
统计/客服/支付 SDK 常需要多个域 + 行内脚本
→ 必须先跑 Report-Only 收集
```

**④ 报告太多了**

```
report-uri 收到海量报告 → 存储/告警都爆
→ 用 report-to + 采样，或只记录关键类型
```

**⑤ 子域与 CDN**

```
用了多个 CDN 子域 → 白名单越来越长
→ 定期清理（不要留"历史遗留"的域名）
```

### 验证方法

**用 curl 看响应头**：

```bash
curl -sI https://example.com | grep -iE "strict-transport|content-security|x-frame|x-content|referrer"
```

**用在线工具**：

```
securityheaders.com
observatory.mozilla.org
```

**"扫一遍拿个 A 评级"** 是很直观的目标。

### 其他值得配的

```
X-XSS-Protection: 0           （现代浏览器已废弃，建议显式关掉旧的过滤，避免误伤）
Cross-Origin-Opener-Policy    （防 Spectre 类侧信道，same-origin）
Cross-Origin-Resource-Policy  （防跨源读取资源，same-site）
Cross-Origin-Embedder-Policy  （需配合 COOP 使用）
```

**COOP/CORP/COEP 三兄弟**是"高安全场景"（如需要 SharedArrayBuffer）才需要，普通站点可后置。

### Nginx 里的注意点

```nginx
# add_header 在子 location 里会"覆盖"父级
# 如果子 location 有自己的 add_header，父级的会全部失效
```

**这是最坑的一点**：

```
父 location 配了 5 个 header
子 location 只配了 1 个 add_header
→ 子 location 只剩那 1 个
```

**解决**：

```
① 用 include 引入公共 header 片段
② 或子 location 也写全
③ 或用 more_set_headers（headers-more 模块，能"追加"）
```

### 一个"标准模板"（可复制）

```nginx
# /etc/nginx/snippets/security-headers.conf
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
add_header Content-Security-Policy "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'" always;

# 使用
server {
    include /etc/nginx/snippets/security-headers.conf;
    ...
}
```

**`Permissions-Policy`** 关掉不需要的浏览器能力（定位/麦克风/摄像头），减少被滥用面。

### 检查清单

```
□ HSTS（先小 max-age 验证）
□ X-Content-Type-Options: nosniff
□ X-Frame-Options 或 CSP frame-ancestors
□ Referrer-Policy: strict-origin-when-cross-origin
□ CSP（先 Report-Only 观察）
□ CSP 不用 'unsafe-inline'（改用 nonce/hash）
□ object-src 'none'、base-uri 'self'
□ Nginx 子 location 的 add_header 覆盖问题已处理
□ 用 securityheaders.com 验证
□ 定期清理白名单里的历史域名
```
