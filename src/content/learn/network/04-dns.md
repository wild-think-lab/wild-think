---
title: DNS：域名怎么变成 IP
module: 入门篇
summary: 解析链路、常见记录类型、缓存与 TTL，以及"改了解析为什么不生效"。
minutes: 20
---

### 为什么需要 DNS

人记 `wild-think-lab.github.io`，机器只认 IP。DNS 就是那本"名字 → 地址"的翻译表，而且它**分布式地存在全世界**。

### 一次解析走了几步

```text
浏览器/系统缓存 → 本地 hosts → 递归 DNS（运营商/公共 DNS）
→ 根域 → .io 顶级域 → 具体权威服务器 → 返回 IP
```

实际路径有缓存，通常一两步就返回。命令行查询用：

```bash
dig wild-think-lab.github.io +short        # 最干净的用法
dig wild-think-lab.github.io               # 完整输出，看 ANSWER 段
nslookup baidu.com                         # Windows 也自带
```

`dig` 完整输出里最重要的三段：

| 段 | 看什么 |
| --- | --- |
| `QUESTION` | 我查的是谁、查什么类型 |
| `ANSWER` | 解析结果和 TTL |
| `SERVER` | 实际是哪个 DNS 服务器回答的 |

### 常见记录类型

| 类型 | 作用 | 例子 |
| --- | --- | --- |
| `A` | 域名 → IPv4 | `blog.example.com → 1.2.3.4` |
| `AAAA` | 域名 → IPv6 | 同上，v6 地址 |
| `CNAME` | 别名 → 另一个域名 | `www → blog.example.com` |
| `MX` | 邮件服务器 | 收件走哪 |
| `TXT` | 任意文本，常做验证 | 域名所有权、SPF |
| `NS` | 这个域由哪台服务器管 | 权威服务器 |

**CNAME 不能和 A 记录同时存在**于同一名字上，这是配域名时最常见的报错来源。

### TTL 与缓存：为什么"改了不生效"

每条记录都带 TTL（秒），意思是"这个结果可以缓存多久"。

- 改解析后，各地缓存里的旧值要等 TTL 到期才更新。
- 上线前把 TTL 调小（如 60），切完再调回，是标准的迁移做法。

验证是否已生效：

```bash
dig @8.8.8.8 example.com +short     # 指定公共 DNS 查，绕开本地缓存
dig @114.114.114.114 example.com +short
```

**指定不同 DNS 服务器对比**，能立刻看出"是我本地缓存旧，还是权威记录本身没改"。

### 常被忽略的两个文件

```bash
cat /etc/hosts                  # 本机硬编码映射，优先级高于 DNS
cat /etc/resolv.conf            # 用的哪个 DNS 服务器
```

`/etc/hosts` 里写错一行，会导致"全公司就这台机器解析不对"。`resolv.conf` 被 NetworkManager 覆盖也是经典问题。

### DNS 故障的三种表现

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `unknown host` / `NXDOMAIN` | 域名不存在或拼错 | 核对域名，`dig` 权威服务器 |
| `SERVFAIL` | DNS 服务器自己出问题 | 换 DNS，查权威配置 |
| 解析很慢（几秒） | DNS 超时重试 | 换公共 DNS（8.8.8.8 / 223.5.5.5） |

注意：`ping 8.8.8.8` 通但 `ping baidu.com` 不通，就是纯 DNS 问题，网络本身没毛病。

### 自己验证

```bash
dig baidu.com +short
dig @8.8.8.8 baidu.com +short
cat /etc/resolv.conf 2>/dev/null || ipconfig /all | findstr DNS
```

看到两组 IP 一致，说明本地 DNS 工作正常。

### 本章小结

- DNS 是分布式的名字翻译表，有缓存和 TTL。
- `A` 是 IPv4、`CNAME` 是别名，两者同名字上不能共存。
- 改解析不生效，先分清是缓存未过期还是记录没配对。
- `dig @指定DNS +short` 是最快的判断手段。

**下一章**：HTTP——一次请求到底长什么样。
