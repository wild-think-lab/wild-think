---
title: SSRF 与文件上传：两个"看起来很普通"的致命入口
description: SSRF 的四种利用方式与防护（含云元数据）、文件上传的六道关口、五个"明明校验了还是被打"的原因。
date: 2026-11-27
tags: [安全, Web, 防护]
---

### 一、SSRF：让服务器替你发请求

**本质**：

```
用户能控制"服务端要访问的 URL"
→ 服务端以自己的身份去访问内网/云元数据
```

### 四种利用方式

```
① 探内网（扫端口/读内网页面）
② 读云元数据（169.254.169.254 拿临时凭据）
③ 打内网服务（Redis 未鉴权、Elasticsearch、K8s API）
④ 协议利用（file:// 读文件、gopher:// 打 Redis）
```

**"只允许 http"** 不够（gopher/dict/file 都能用）。

### 云元数据的特殊风险

```
AWS：http://169.254.169.254/latest/meta-data/iam/...
阿里云：http://100.100.100.200/latest/meta-data/
腾讯云：http://metadata.tencentyun.com/
```

**后果**：拿到实例角色的临时凭据 → 直接接管云资源。

**防护（最重要的一条）**：

```bash
# AWS IMDSv2（要求 token，SSRF 打不了）
aws ec2 modify-instance-metadata-options \
  --instance-id i-xxx --http-tokens required --http-put-response-hop-limit 1
```

**"开了 IMDSv2"** 能挡掉绝大多数 SSRF 横向。

### 防护清单（代码层）

```
① 白名单（只允许指定域名/IP 段）—— 最有效
② 解析后校验（防 DNS rebinding：解析结果必须在白名单）
③ 禁止重定向（或重定向后再次校验）
④ 禁止非 http(s) 协议
⑤ 禁止访问内网/保留地址（10/8、172.16/12、192.168/16、169.254/16、127/8）
⑥ 出网统一走代理（代理侧做白名单）
```

**"只校验字符串前缀 http://"** 会被 `http://127.0.0.1@evil.com` 绕过。

### 二、文件上传：六道关口

```
① 大小限制（在网关就拦）
② 类型校验（内容嗅探，不只看扩展名）
③ 存储隔离（不放在 Web 根目录、不放在可执行路径）
④ 文件名随机化（不复用用户文件名）
⑤ 权限（上传目录不可执行）
⑥ 病毒扫描（可选，但对内网分享重要）
```

**最典型的错误**：

```
把上传文件放在 /uploads 且该目录能执行 PHP/JSP
→ 传个 .php 就是 shell
```

### 类型校验怎么做

```python
# 不要这样（可伪造）
if filename.endswith(".jpg"): ...

# 要这样：读文件头 + 重编码
from PIL import Image
img = Image.open(path); img.verify()
img = img.convert("RGB"); img.save(new_path, "JPEG")
```

**"重编码"** 能去掉图片里的恶意载荷（EXIF/附加数据）。

### 存储与访问

```
① 放对象存储（不在应用服务器）
② 用签名 URL 访问（不直接暴露路径）
③ 下载时 Content-Disposition: attachment（防内联执行）
④ 独立域名（与主站不同源，防 XSS 读 Cookie）
```

### 五个"明明校验了还是被打"

**① 只校验前端**

```
前端 accept="image/*" → 直接改请求就绕过
```

**② 只校验扩展名**

```
shell.php.jpg / shell.php%00.jpg（旧版本）
```

**③ 校验后又被"二次处理"**

```
图片处理库有漏洞（ImageMagick 历史 RCE）
→ 用安全库 + 沙箱
```

**④ 存储路径可预测**

```
/uploads/2026/11/27/1.jpg → 遍历/覆盖
```

**⑤ 压缩包解压**

```
zip slip：解压路径穿越 → 写到任意目录
→ 解压前校验条目路径
```

### 一个"够用"的上传实现顺序

```
1) 网关：大小 + 频率限制
2) 应用：读文件头判类型（白名单）
3) 重编码/清洗（图片/文档）
4) 随机文件名 + 对象存储
5) 独立域名 + 签名 URL + attachment
6) 后台异步扫描（可选）
```

### 检查清单

```
□ 云实例开 IMDSv2（或等价）
□ SSRF：白名单 + 解析后校验 + 禁重定向
□ 禁止非 http(s) 协议
□ 禁止内网/保留地址
□ 出网走统一代理
□ 上传：大小/类型/隔离/随机名/不可执行
□ 图片重编码
□ 独立域名 + 签名 URL
□ 解压校验路径（防 zip slip）
□ 下载用 attachment
□ 有"内网探测"日志告警（异常出站）
□ 定期做 SSRF/上传专项测试
```
