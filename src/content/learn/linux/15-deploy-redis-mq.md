---
title: 部署缓存与消息：Redis 与 RabbitMQ
module: 熟练篇
summary: Redis 的安装与四个必改配置、持久化取舍；RabbitMQ 的安装、vhost 与队列、五个"消费不动"的原因。
minutes: 50
---

## 一、先弄懂它们是什么

这里其实是两类完全不同的东西，混在一起讲是因为它们常一起出现：

```
Redis：内存数据结构服务器（缓存 / 计数 / 排行榜 / 分布式锁）
RabbitMQ：消息中间件（任务分发 / 异步解耦 / 削峰）
```

### Redis 为什么快，以及它为什么"单线程"

```
① 纯内存操作，没有磁盘 IO 等待
② 单线程执行命令 → 没有锁竞争，逻辑简单
③ IO 多路复用（epoll）→ 一个线程管上万连接
```

**判据**：Redis 变慢通常不是 CPU，而是"大 key / 慢命令（KEYS、SMEMBERS 大集合）/ 网络往返"。

### Redis 的关键概念

| 概念 | 含义 | 用错会怎样 |
| --- | --- | --- |
| 数据结构 | String/List/Hash/Set/ZSet/Stream | 用 String 存大 JSON，无法局部更新 |
| 过期（expire） | 到期自动删 | 忘记设 → 内存只涨不降 |
| 淘汰策略 | 内存满了删谁（LRU/LFU/random/noeviction） | noeviction → 写入直接报错 |
| 持久化 | RDB（快照）/ AOF（追加日志） | 只开 RDB → 宕机丢几分钟 |
| 单线程 | 命令串行 | 一条慢命令阻塞所有请求 |

### 缓存三个经典问题（面试常问，也是真会出事）

```
穿透：查不存在的数据 → 每次都打到 DB（解法：空值缓存 + 布隆过滤器）
击穿：热点 key 过期瞬间 → 大量请求打 DB（解法：互斥重建 + 不过期预热）
雪崩：大量 key 同时过期 → DB 被打挂（解法：过期时间加随机抖动）
```

### RabbitMQ 的模型（和 Kafka 完全不同）

```
生产者 → Exchange（按 routing key 路由）→ Binding → Queue → 消费者（ack）
```

| 概念 | 作用 | 关键点 |
| --- | --- | --- |
| Exchange | 路由规则（direct/topic/fanout） | 没绑定的消息会被丢弃 |
| Queue | 存储消息 | durable 才持久化 |
| ack | 消费确认 | 手动 ack 才能"处理成功再删" |
| prefetch | 预取条数 | 太大会让单消费者阻塞 |
| DLX | 死信交换机 | 失败消息的去处 |

### 两者的选型边界

```
Redis：要极致低延迟、数据结构操作、可丢（缓存）/ 或小规模持久
RabbitMQ：要可靠投递、复杂路由、任务分发、逐条 ack
Kafka：要吞吐、可重放、多消费者各自进度
```

### Redis 安装

```bash
dnf install -y redis
systemctl enable --now redis
redis-cli ping
```

**生产建议**：用官方源/容器，系统自带版本常偏旧。

### Redis 四个必改

```conf
bind 0.0.0.0
requirepass <强密码>
maxmemory 4gb
maxmemory-policy allkeys-lru
```

```
① bind：默认只允许本机（对外要显式）
② 密码：没有密码的 Redis 是最常见的被入侵入口
③ 内存上限：不设会吃光整机内存
④ 淘汰策略：noeviction 时写入会直接报错
```

**危险配置**：

```conf
# 绝对不要
protected-mode no
rename-command CONFIG ""
```

**"Redis 被用来挖矿"** 基本都源于"无密码 + 公网可达"。

### 持久化怎么选

```
RDB：定时快照（快、可能丢几分钟）
AOF：追加日志（更安全、文件更大）
混合：RDB + AOF（推荐）
```

```conf
appendonly yes
appendfsync everysec
save 900 1
```

**"缓存丢了无所谓"** → 可以关持久化；但"当存储用"必须开。

### RabbitMQ 安装

```bash
dnf install -y erlang
rpm -Uvh rabbitmq-server-*.rpm
systemctl enable --now rabbitmq-server
rabbitmq-plugins enable rabbitmq_management
```

**管理台**：`http://host:15672`（默认 guest/guest 仅本机）。

### vhost 与用户

```bash
rabbitmqctl add_vhost app
rabbitmqctl add_user app '<强密码>'
rabbitmqctl set_permissions -p app app ".*" ".*" ".*"
rabbitmqctl set_user_tags app monitoring
```

**"所有人都用 guest"** → 无法按业务隔离与授权。

### 队列与交换机

```
exchange（路由）→ binding → queue（存储）
类型：direct / topic / fanout / headers
```

```bash
rabbitmqadmin declare exchange name=orders type=topic durable=true
rabbitmqadmin declare queue name=order.created durable=true
rabbitmqadmin declare binding source=orders destination=order.created routing_key="order.created"
```

### 五个"消费不动"

**① 队列堆积**

```
消费者挂了/太慢 → 看队列长度与 unacked
```

**② prefetch 太大**

```
一次拉太多 → 单消费者阻塞，其他空闲
```

**③ 队列没绑定**

```
消息进了 exchange 但没有 binding → 被丢弃（无 DLX 时）
```

**④ 消息未确认（unacked）堆积**

```
消费者处理失败但没 nack → 卡住
```

**⑤ 磁盘/内存告警**

```
RabbitMQ 触发流控（block）→ 生产者被阻塞
```

```bash
rabbitmqctl list_queues name messages messages_unacknowledged consumers
rabbitmqctl status | grep -A5 "memory"
```

### 可靠性三件套

```
① 持久化（durable queue + persistent message）
② 手动 ack（处理成功再确认）
③ 死信队列（失败消息有去处）
```

```bash
rabbitmqadmin declare queue name=order.created arguments='{"x-dead-letter-exchange":"dlx"}'
```

### 检查清单（Redis）

```
□ 设了密码
□ bind 限制（不裸奔公网）
□ maxmemory + 淘汰策略
□ 持久化与业务容忍度匹配
□ 有连接数与内存监控
□ 危险命令重命名/禁用
□ 有主从或哨兵（如需要）
```

### 检查清单（RabbitMQ）

```
□ 非 guest 账号 + vhost 隔离
□ 队列 durable + 消息 persistent
□ 手动 ack
□ 有 DLX
□ prefetch 合理
□ 有队列长度告警
□ 有内存/磁盘告警（防流控）
□ 有消费者健康检查
```
