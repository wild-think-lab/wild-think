---
title: HTTP 缓存与 CDN：为什么改了页面用户还是看到旧的
description: 强缓存/协商缓存、ETag 与 Vary、CDN 刷新与预热，以及五个"缓存不生效"的原因。
date: 2026-11-27
tags: [网络, HTTP, CDN]
---

### 两级缓存

```
① 强缓存（不发请求）
   Cache-Control: max-age=3600
② 协商缓存（发请求但可能 304）
   ETag / Last-Modified
```

**"改了页面没变"** → 99% 是强缓存还在有效期。

### 响应头怎么写

```
# 静态资源（带 hash 文件名，可长久）
Cache-Control: public, max-age=31536000, immutable

# HTML（必须每次验证）
Cache-Control: no-cache
（no-cache ≠ 不缓存，而是"每次要验证"）

# 完全不缓存
Cache-Control: no-store
```

**最常见错误**：

```
HTML 也设 max-age=86400 → 用户一天看不到更新
```

### ETag 与"304 的坑"

```
ETag: "abc123"
下次请求 If-None-Match: "abc123" → 304
```

**坑**：

```
① 多台后端生成的 ETag 不一致（集群环境用强 ETag 会抖动）
② 压缩前后 ETag 变化（不同节点不同）
③ 304 响应不带 body，但 Content-Length 可能误导客户端
```

**解决**：ETag 基于"内容 hash"，或直接用文件 hash 命名。

### Vary 头

```
Vary: Accept-Encoding
Vary: Accept-Language
```

**"不同设备拿到同一份缓存"** → 少了 Vary。

**坑**：`Vary: User-Agent` 会让缓存命中率归零（UA 千变万化）。

### CDN 的三层

```
① 边缘节点（用户最近）
② 中间层（区域）
③ 源站
```

**回源**：

```
未命中 → 回源 → 缓存 → 返回
```

**"CDN 上还是旧内容"** → 边缘节点未过期，且没刷新。

### 刷新与预热

```bash
# 阿里云/腾讯云 都有 API
# 刷新（URL 或目录）
# 预热（提前把内容拉到边缘）

# 通用原则：
① 变更后按"文件"刷新（不要整站）
② 大促前预热（避免首访回源打爆）
③ 刷新有延迟（几分钟）
```

**"刷新了立即生效"** 是期望不是事实（边缘节点多）。

### 五个"缓存不生效"

**① 请求带了 `Cache-Control: no-cache`（浏览器强制刷新）**

```
F12 里勾了 Disable cache → 一直回源
```

**② 响应头被中间层改掉**

```
网关/代理覆盖了 Cache-Control
→ 用 curl -I 看"最终响应头"
```

**③ 资源 URL 不变**

```
改了 app.js 但 URL 还是 app.js → 缓存不会失效
→ 用 hash 文件名
```

**④ 多 CDN/多域名**

```
A 域名刷新了，B 域名没刷
```

**⑤ 客户端本地缓存（App/小程序）**

```
HTTP 缓存之外还有一层本地存储
```

### 一套"不会踩坑"的策略

```
① HTML：no-cache（每次验证）
② JS/CSS/图片：文件名带 hash + immutable 一年
③ 接口：按"是否可缓存"设（默认 no-store）
④ CDN：只刷 HTML，静态资源靠 hash 自动更新
⑤ 版本发布：新 HTML 引用新 hash 资源（原子切换）
```

**"原子切换"** 的意义：用户要么看到旧版全套，要么新版全套，不会"新 HTML + 旧 JS"。

### 验证命令

```bash
curl -I https://example.com/index.html
curl -I https://example.com/app.abc123.js
# 看 Cache-Control / ETag / Age / X-Cache
```

`X-Cache: HIT/MISS` 是判断 CDN 命中的直接证据。

### 检查清单

```
□ HTML 是 no-cache
□ 静态资源带 hash
□ 静态资源 immutable 长缓存
□ 接口默认 no-store（除非明确可缓存）
□ Vary 只加必要维度
□ 变更只刷 HTML
□ 大促前预热
□ 用 curl -I 验证最终头
□ 多域名/CDN 同步刷新
□ 客户端本地缓存有清理机制
```
