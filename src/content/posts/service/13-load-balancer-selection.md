---
title: 负载均衡选型：LVS、HAProxy、Nginx 各自适合哪一层
description: 四层与七层的分工、三种实现的性能与功能边界、健康检查的四种方式、以及"后端全挂但用户还能访问"的诡异现象。
date: 2023-12-14
tags: [负载均衡, LVS, HAProxy, Nginx]
---

### 四层与七层

```
四层（L4）：看 IP + 端口，转发 TCP 连接        → LVS、HAProxy(tcp)
七层（L7）：看 HTTP 内容，可改请求/响应        → Nginx、HAProxy(http)
```

| | 四层 | 七层 |
| --- | --- | --- |
| 性能 | 高（内核态/少解析） | 中（要解析 HTTP） |
| 能力 | 仅转发 | 路由、改写、缓存、限流 |
| 后端感知 | 只知 IP:Port | 知 Host/Path/Header |
| 典型位置 | 入口最外层 | 应用网关 |

常见架构：

```
LVS（四层，扛连接数）→ Nginx（七层，做路由）→ 应用
```

### 三者对比

| | LVS | HAProxy | Nginx |
| --- | --- | --- | --- |
| 层级 | L4 | L4 + L7 | L7（+ L4 stream） |
| 性能上限 | 最高（DR 模式可达线速） | 高 | 中高 |
| 健康检查 | 简单（TCP/keepalived） | 很强（HTTP/自定义） | 基础（被动 + 主动需模块） |
| 会话保持 | 源 IP 哈希 | cookie/源 IP/header | ip_hash/sticky |
| 配置复杂度 | 中（DR 模式网络配置麻烦） | 中 | 低 |
| 可观测 | 弱 | 强（内置统计页） | 中（日志） |

判断：

- **需要极致吞吐、只做转发** → LVS。
- **需要精细健康检查与会话保持** → HAProxy。
- **需要 HTTP 路由、改写、缓存** → Nginx。

### 健康检查的四种方式

**① TCP 检查（端口是否可连）**

```haproxy
server web1 10.0.0.1:8080 check
```

只能发现"进程挂了"，发现不了"进程在但业务错"。

**② HTTP 状态检查**

```haproxy
server web1 10.0.0.1:8080 check check-http /health
```

要求后端提供 `/health`，且返回 200 才认为健康。

**③ 内容检查**

```haproxy
option httpchk GET /health
http-check expect string "ok"
```

能发现"返回 200 但实际不可用"的情况。

**④ 被动检查（根据真实流量判断）**

```haproxy
server web1 10.0.0.1:8080 check observe layer7 error-limit 10
```

连续 10 次 5xx 才摘除，不影响正常流量。

**建议组合**：主动 HTTP 检查（快发现）+ 被动观察（防误判）。

### 健康检查的坑：误摘与抖振

```
后端慢 → 健康检查超时 → 摘除 → 剩余节点更慢 → 继续摘 → 全摘
```

防抖三招：

1. **调大检查间隔与超时**（如间隔 5s、超时 2s、连续 3 次失败才摘）。
2. **摘除后降速恢复**（慢启动，`slowstart 30s`）。
3. **保留最小可用数**（不把所有节点摘完）。

```haproxy
default-server inter 5s downinter 2s rise 3 fall 3 slowstart 30s
```

### 会话保持

| 方式 | 适用 | 代价 |
| --- | --- | --- |
| 源 IP 哈希 | 无 cookie 的协议 | NAT 后大量用户同 IP，分布不均 |
| Cookie 插入 | HTTP 应用 | 需要应用不校验 cookie 完整性 |
| Header 哈希 | 有业务标识（如 tenant） | 需要业务配合 |

**最优解是把应用做成无状态**（会话放 Redis），就不需要会话保持。会话保持是过渡方案，不是目标。

### 诡异现象：后端全挂但用户还能访问

某次故障：3 个后端全挂，但部分用户仍能打开页面。

原因：**Nginx 的缓存**。缓存命中的请求根本没到后端。

排查方法：

```bash
# 看缓存命中
grep -c HIT /var/log/nginx/access.log
```

这类"看起来正常"最难排查。要么在故障时禁用缓存，要么给缓存加"后端不可用时失效"的逻辑（`proxy_cache_use_stale` 慎用）。

### 高可用：负载均衡器自己不能是单点

```
方案 A：keepalived + VIP（主备）
方案 B：DNS 轮询 + 多台 LB（要有健康检查）
方案 C：云厂商 LB（托管）
```

keepalived 的关键配置：

```conf
vrrp_instance VI_1 {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1
    virtual_ipaddress { 10.0.0.100/24 }
    track_script { chk_nginx }
}
```

```bash
vrrp_script chk_nginx {
    script "/usr/bin/pgrep nginx"
    interval 2
    fall 2
    rise 2
}
```

`track_script` 必须有：否则 nginx 挂了但 keepalived 还认为健康，VIP 不会漂移。

脑裂风险：两台都认为自己是 MASTER。防法：

- 加第二块网卡做心跳专线。
- 或用 `unicast_peer` 指定对端地址，避免组播被隔离。

### 选型决策

| 场景 | 选 |
| --- | --- |
| 单机 >10 万并发连接、纯转发 | LVS DR |
| 需要细粒度健康检查与会话保持 | HAProxy |
| HTTP 路由、灰度、缓存、限流 | Nginx |
| 不想自建 | 云 LB / 云 API 网关 |

小团队推荐：**Nginx 一把梭**。它的七层能力够用，运维成本最低；只有当连接数或健康检查精度成为瓶颈时，才引入 HAProxy/LVS。
