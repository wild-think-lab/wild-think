---
title: 负载均衡与代理：LVS / HAProxy / Nginx
module: 进阶篇
summary: 四层与七层的分工、常见算法、健康检查与会话保持，五个"加了 LB 反而更慢"的原因。
minutes: 45
---

### 先分层

```
四层（LVS / DSR）：只看 IP+端口，极高吞吐，不改内容
七层（Nginx / HAProxy / Envoy）：看 HTTP，能路由/改头/限流
```

**判据**：

```
需要按 URL/Host 路由 → 七层
纯 TCP 大流量（数据库/长连接）→ 四层
```

### LVS 三种模式

```
① NAT：改目标地址，回程也过 LVS（LVS 易成瓶颈）
② DR（直接路由）：只改 MAC，回程直接回客户端（最常用）
③ TUN：跨机房封装
```

```bash
ipvsadm -A -t 10.0.0.10:80 -s rr
ipvsadm -a -t 10.0.0.10:80 -r 10.0.0.11:80 -g -w 1
ipvsadm -a -t 10.0.0.10:80 -r 10.0.0.12:80 -g -w 1
ipvsadm -L -n
```

**DR 模式关键**：后端要在 lo 上配 VIP 并抑制 ARP 通告。

### HAProxy 配置

```conf
frontend web
    bind *:80
    default_backend app

backend app
    balance leastconn
    option httpchk GET /healthz
    http-check expect status 200
    server app1 10.0.0.11:8080 check inter 3s fall 2 rise 3
    server app2 10.0.0.12:8080 check inter 3s fall 2 rise 3
```

**`fall 2 rise 3`**：连续 2 次失败摘除，连续 3 次成功恢复（避免抖动）。

### 算法怎么选

```
rr：均分（适合同规格）
leastconn：最少连接（长连接/耗时不一）
source：按源 IP 哈希（简易会话保持）
uri：按 URL 哈希（缓存友好）
```

**"一律用 rr"** → 慢请求堆在同一台上。

### 会话保持三种

```
① 源 IP 哈希（NAT 后大量用户共用一个 IP → 失衡）
② Cookie 插入（七层可用，最可靠）
③ 共享会话（Redis）——真正的解法
```

**根本方案**：应用无状态 + 共享存储会话。

### 五个"加了 LB 反而更慢"

**① 健康检查太频繁**

```
每 100ms 一次 → 后端被探活打满
```

**② 没有连接复用**

```
LB 到后端每请求新建连接
```

**③ 超时设置错误**

```
后端 30s，LB 5s → 大量 504
```

**④ 只有一台 LB**

```
LB 自己成了单点
```

**⑤ 会话粘性导致倾斜**

```
一台 90%，一台 10%
```

### 关键指标

```
① 每秒新建连接
② 后端错误率（5xx/连接失败）
③ 摘除/恢复次数（抖动）
④ P99 响应时间（含排队）
```

### 检查清单

```
□ 四层/七层按需求选对
□ 健康检查间隔合理（3-10s）
□ 有 fall/rise 防抖
□ LB 到后端有连接复用
□ 超时链路一致（LB ≥ 后端）
□ 会话无状态或有共享存储
□ LB 自身高可用（主备 + VIP）
□ 有连接数与错误率监控
□ 有摘除告警
□ 变更前后有压测对比
```
