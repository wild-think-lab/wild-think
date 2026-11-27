---
title: 部署缓存与消息：Redis 与 RabbitMQ
module: 进阶篇
summary: Redis 的安装与四个必改配置、持久化取舍；RabbitMQ 的安装、vhost 与队列、五个"消费不动"的原因。
minutes: 50
---

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
