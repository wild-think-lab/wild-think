---
title: 长连接推送：WebSocket 在一万台设备上会怎么崩
description: 连接保持、心跳与重连、广播模型、以及五个"连接数上不去/上去就崩"的原因。
date: 2026-08-13
tags: [后端, WebSocket, 长连接]
---

### 与轮询的差别

```
轮询：客户端定时问（简单，浪费）
长轮询：挂起请求（折中）
WebSocket：全双工（实时）
SSE：服务端单向推送（够用就简单）
```

**"只需要服务端推" → SSE 更省事**（HTTP 语义、易过代理）。

### 连接保持的四个要素

```
① 心跳（ping/pong）：让中间设备不掐连接
② 重连：指数退避 + 抖动
③ 会话恢复：断线后能补到"漏掉的消息"
④ 连接上限：单机多少连接、总容量多少
```

**"只有心跳没有会话恢复"** → 断线期间的消息永久丢失。

### 单机能撑多少连接

```
取决于：内存/连接 + 文件描述符 + 事件循环效率
典型值：
  Go/Netty：单机 5 万–10 万（内存充足、fd 调优后）
  Node.js：单机 1 万–3 万（视业务）
  Nginx 反代：注意 worker_connections
```

**必须调的两项**：

```bash
ulimit -n 100000
# /etc/security/limits.conf
* soft nofile 100000
* hard nofile 100000
```

```conf
# nginx
worker_connections 65535;
proxy_read_timeout 3600s;
```

**"连接一到 1 万就全断"** 通常是 fd 或 nginx 的 worker_connections 限制。

### 心跳与超时

```javascript
// 客户端
const timer = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 30000);
ws.onmessage = (e) => { lastSeen = Date.now(); };

// 服务端
setInterval(() => {
  for (const c of clients) {
    if (Date.now() - c.lastSeen > 90000) c.close(4000, "timeout");
    else c.ping();
  }
}, 30000);
```

**心跳间隔要小于"中间设备的空闲超时"**：

```
LB/NAT 常见 60s 空闲断开
→ 心跳 ≤ 30s
```

**"心跳 5 分钟"** 会被 LB 静默切断（表现为"每 60 秒重连一次"）。

### 重连策略

```javascript
let retry = 0;
function connect() {
  ws = new WebSocket(url);
  ws.onopen = () => { retry = 0; resync(); };
  ws.onclose = () => {
    const delay = Math.min(30000, 1000 * 2 ** retry) + Math.random() * 1000;
    retry++;
    setTimeout(connect, delay);
  };
}
```

**"抖动（jitter）"** 防止所有客户端同时重连（惊群）。

**"服务端重启后 3 万客户端同时重连"** 是经典雪崩。

### 广播模型

```
① 单机内存 map：简单，但无法多实例
② Redis Pub/Sub：多实例广播（无持久化）
③ Kafka/Redis Stream：可持久化、可回放（推荐）
④ 网关按"用户→连接"路由（定向推送）
```

**水平扩展的关键**：

```
每个实例订阅"发给本实例连接的频道"
或"任何实例发消息 → 通过总线 → 持有该连接的实例投递"
```

### 五个"上不去/上去就崩"的原因

**① fd 上限**

```
ulimit -n 1024 → 一千个连接就报 "too many open files"
```

**② 每连接一个线程**

```
阻塞 IO 模型 → 1 万线程 → 上下文切换打满 CPU
→ 用事件驱动（epoll/kqueue）
```

**③ 消息无节制推送**

```
全量广播 + 大 payload → 带宽打满 + 客户端处理不过来
→ 按主题订阅、按需推送、合批
```

**④ 缺少"离线消息"**

```
用户离线期间的推送直接丢弃 → 上线后看不到
→ 落库或进队列，上线后拉取
```

**⑤ 没做"连接数监控"**

```
不知当前多少连接 → 容量规划全靠猜
```

### 一个"最小可用"的架构

```
客户端 → L4 LB → WS 网关（多实例）→ 业务服务
                     ↕
              Redis/Kafka（广播 + 离线消息）
```

**要点**：

```
① 网关无状态（连接与会话分离，会话存 Redis）
② 业务服务不直接持有连接（通过总线转发）
③ 网关可水平扩展
```

### 检查清单

```
□ 心跳 ≤ 30s
□ 服务端有超时清理
□ 重连有退避 + 抖动
□ 断线能补消息（离线消息/序列号）
□ fd 上限已调
□ nginx worker_connections 已调
□ 事件驱动模型（不是一线程一连接）
□ 有连接数指标与告警
□ 广播走总线（不靠单机 map）
□ 大 payload 有压缩与限流
□ 网关可水平扩展
```
