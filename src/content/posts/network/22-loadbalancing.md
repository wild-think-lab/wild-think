---
title: 负载均衡：四层与七层的分界线在哪
description: L4/L7 的差别、健康检查的三种方式、会话保持与一致性哈希，以及五个"加了 LB 反而更慢"的原因。
date: 2025-08-18
tags: [网络, 负载均衡, 架构]
---

### 四层 vs 七层

| 维度 | L4（TCP） | L7（HTTP） |
| --- | --- | --- |
| 依据 | IP/端口 | URL/Header/Cookie |
| 性能 | 高 | 略低（要解析） |
| 能力 | 转发 | 路由/改写/鉴权/限流 |
| 场景 | 数据库、TCP 服务、大流量透传 | Web API、灰度、网关 |

**"所有流量都上 L7"** 会增加延迟与成本（非 HTTP 用不了）。

### 健康检查的三种

```
① TCP 探活：能建连就算健康（不够准，应用可能已 hang）
② HTTP 探活：200 才算健康（最实用）
③ 业务探活：依赖可用性（DB/缓存也检查）
```

**"只做 TCP 探活"** → 应用假死也会被摘到流量。

**推荐**：

```
L4：TCP + 短间隔（5s）
L7：HTTP /healthz（含依赖检查，但依赖故障时别一起挂）
```

**"健康检查查了 DB"** 的风险：

```
DB 抖动 → 所有实例不健康 → LB 摘掉全部后端 → 全站 503
→ 依赖检查要分级（critical / non-critical）
```

### 会话保持

```
① 源 IP 哈希（NAT 后大量同源）
② Cookie 注入（L7 可用）
③ 一致性哈希（按用户 ID）
```

**"必须保持会话"通常是设计问题**：

```
把 session 放 Redis → 就不需要会话保持了（可水平扩展）
```

### 负载算法

```
轮询（round robin）      ：默认，均匀
最少连接（least conn）   ：长连接友好
加权（weighted）         ：按机器规格
一致性哈希             ：缓存命中率友好
```

**"最少连接"** 在"请求耗时差异大"的场景明显更好。

### 五个"加了 LB 反而更慢"

**① LB 本身是瓶颈**

```
单实例 + 小规格 → 提前打满
→ 需要多实例 + 前置 L4（或用云 LB）
```

**② 健康检查太频繁**

```
每秒探一次 + 慢接口 → 探活本身占满后端
```

**③ 会话保持导致不均**

```
哈希倾斜 → 某台后端压力翻倍
```

**④ 后端连接不复用**

```
LB → 后端 每次新建连接 → 握手开销 + 端口耗尽
→ 开启 upstream keepalive
```

```nginx
upstream app {
  server 10.0.0.1:8080;
  keepalive 32;
}
```

**⑤ TLS 终止位置不合理**

```
LB 终止 TLS → 内网明文（合规问题）
LB 透传 → 后端要处理 TLS（CPU 压力）
```

**"内网明文"** 在等保/审计场景会被指出。

### 一个"多层"的现实架构

```
DNS → L4（四层，抗量）→ L7（路由/鉴权）→ 服务
```

**每层职责**：

```
L4：抗大流量、DDoS 清洗
L7：路由、灰度、限流、鉴权
```

**"一层做所有事"** 会导致"要扩就得整体扩"。

### Nginx 的关键配置

```nginx
upstream app {
  least_conn;
  server 10.0.0.1:8080 max_fails=3 fail_timeout=30s;
  server 10.0.0.2:8080 max_fails=3 fail_timeout=30s;
  keepalive 32;
}

server {
  location / {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_connect_timeout 3s;
    proxy_read_timeout 30s;
  }
}
```

**`proxy_http_version 1.1` + `Connection ""`** 是 keepalive 生效的前提（少了就退化成短连接）。

### 检查清单

```
□ 明确 L4/L7 分工
□ 健康检查用 HTTP（不只 TCP）
□ 依赖检查分级（避免全站摘除）
□ 会话状态外置（不依赖会话保持）
□ 有用"最少连接"或加权
□ LB 多实例/高可用
□ 探活频率合理
□ 后端连接复用（keepalive）
□ TLS 终止位置明确
□ 有 LB 层监控（连接数/5xx/延迟）
```
