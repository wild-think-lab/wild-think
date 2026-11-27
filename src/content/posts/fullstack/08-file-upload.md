---
title: 文件上传：从"能传"到"敢上线"要补的六件事
description: 直传与中转的选择、分片与断点续传、类型与内容校验、图片处理链路、存储路径设计与清理策略、以及上传相关的三个安全坑。
date: 2022-10-20
tags: [全栈, 文件上传, 对象存储, 安全]
---

### 先选路径：中转 vs 直传

```
中转：客户端 → 你的服务 → 对象存储
直传：客户端 →（拿签名）→ 对象存储（你的服务只收回调）
```

| | 中转 | 直传 |
| --- | --- | --- |
| 实现难度 | 低 | 中（要签名与回调校验） |
| 服务器带宽成本 | 高（走一遍流量） | 低 |
| 能否在服务端校验内容 | 能 | 需下载后校验或依赖存储侧 |
| 大文件稳定性 | 差（超时、内存） | 好 |

判断：**文件 > 10MB 或量大，直传**；小头像类可以中转，但也要限制大小。

### 分片与断点续传

大文件必须分片，否则一个 2GB 上传失败就得从头来。

```
① 客户端算文件 hash（如 SHA256 前 16 位）
② 请求 /upload/init → 返回 uploadId 与已传分片列表（秒传/续传判断）
③ 逐片上传 PUT /upload/{uploadId}/{partNo}
④ 全部完成后 POST /upload/complete → 服务端合并并校验
```

关键设计：

- **分片大小固定**（如 5MB），便于服务端合并与校验。
- **秒传**：hash 命中已有文件就直接返回成功，省流量。
- **服务端记录每个分片的 etag**，合并时要按顺序且校验一致性。

```python
# 伪代码：合并时校验分片数
expected = (size + part_size - 1) // part_size
if len(parts) != expected:
    raise Invalid("missing parts")
```

### 类型校验：三重，缺一不可

1. **扩展名**（廉价，但可伪造）。
2. **Content-Type**（可伪造）。
3. **文件头魔数**（真实）。

```python
MAGIC = {
    b"\x89PNG\r\n\x1a\n": "png",
    b"\xff\xd8\xff": "jpg",
    b"GIF89a": "gif",
    b"%PDF-": "pdf",
}

def sniff(head: bytes) -> str | None:
    for sig, ext in MAGIC.items():
        if head.startswith(sig):
            return ext
    return None
```

只信扩展名 → 攻击者传 `shell.php.jpg`；
只信 Content-Type → 改个 header 就绕过。
**三重都过，并且最终以魔数为准**。

另外要做：

- 上传目录**不可执行**（Nginx 配 `location ~* /uploads/ { ... }` 禁止解析 PHP）。
- 文件名重写为随机 ID，**不要保留用户提供的原名**（原名可能含 `../` 或特殊字符）。

### 图片处理链路

```python
# 上传后异步：缩略图 + 压缩 + 水印
def on_uploaded(key):
    src = download(key)
    for size in [(120,120), (480,480), (1080,1080)]:
        thumb = resize(src, size)
        upload(f"thumb/{size[0]}/{key}", compress(thumb, quality=82))
```

要点：

1. **图片处理放异步队列**，不要在上传请求里同步做（用户会等很久）。
2. **限制像素总数**而不是只限文件大小：一张 10 万×10 万像素的 1MB PNG 能打爆内存（解压炸弹）。
3. 处理用独立进程/容器，配内存上限，避免拖垮主服务。

### 存储路径设计

不要用"用户上传时间"做目录，要用**不可变 key**：

```
原始文件：objects/{hash前2位}/{hash}.{ext}
缩略图：  thumbs/{size}/{hash}.webp
```

好处：

- 同一文件只存一份（内容寻址，天然去重）。
- 路径不泄露用户 ID 与时间信息。
- CDN 缓存友好（key 不变即可永久缓存）。

**不要**用 `uploads/2026/11/27/user123/文件名`：泄露信息、难去重、改路径要迁移全量数据。

### 清理策略

| 对象 | 策略 |
| --- | --- |
| 未完成的分片 | 24 小时后清理 |
| 上传成功但未被引用的文件 | 定期对账（DB 引用 vs 存储对象） |
| 缩略图 | 跟随原图生命周期 |
| 用户删除 | 软删 + 延迟物理删除（防误删） |

对账脚本是最有价值的一项：

```sql
-- 找出存储里有但数据库没引用的对象（候选清理）
SELECT key FROM storage_objects o
LEFT JOIN file_refs r ON r.key = o.key
WHERE r.key IS NULL AND o.created_at < now() - interval '30 days';
```

### 三个安全坑

**① 路径穿越**

```python
# 危险
path = os.path.join(UPLOAD_DIR, filename)   # filename = "../../etc/passwd"
# 安全：只接受服务端生成的 key
path = os.path.join(UPLOAD_DIR, uuid4().hex + ext)
```

**② 存储桶公开可写 / 可列目录**

- 桶策略只允许 `GetObject`，**绝不**允许 `PutObject` 与 `ListBucket`。
- 访问走 CDN 签名 URL 或应用层鉴权，不要把桶直接暴露。

**③ 上传即执行**

- 上传目录用独立域名或独立路径，返回 `Content-Disposition: attachment`。
- 服务端返回上传内容时**必须设置 `Content-Type` 为真实类型**，且加 `X-Content-Type-Options: nosniff`。

### 上线检查清单

```
□ 单文件大小上限（服务端 + 网关两层）
□ 总配额与频率限制（防刷）
□ 分片上传与断点续传
□ 魔数校验 + 文件名重写
□ 上传目录不可执行
□ 图片处理异步 + 像素上限
□ 存储 key 不可变、可去重
□ 未完成分片与孤儿对象有清理
□ 下载走签名 URL，桶不可列
```
