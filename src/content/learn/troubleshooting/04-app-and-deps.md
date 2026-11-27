---
title: 应用与依赖层排错：日志、线程、数据库
module: 入门篇
summary: 从应用日志里读出层级、用线程栈定位卡死、用连接池与慢查询判断依赖问题，附"502/504/499"的对应含义。
minutes: 26
---

### 从 HTTP 状态码反推层

| 状态码 | 返回方 | 大概率问题 |
| --- | --- | --- |
| 499 | Nginx | 客户端先放弃（服务太慢） |
| 502 | 网关 | 后端进程不在/崩了/连不上 |
| 503 | 网关/应用 | 后端过载或被摘除 |
| 504 | 网关 | 后端处理超时 |
| 500 | 应用 | 应用自身异常 |
| 429 | 网关/应用 | 限流 |

**这把"是哪一层"的问题直接缩小了**。

```
502 + 后端进程在 → 看端口/连接数是否打满
504 + 后端日志有慢查询 → 依赖慢
500 + 应用异常栈 → 应用代码/数据问题
499 多 → 应用响应太慢（用户等不了）
```

### 从日志里读层级

**结构化日志最好用**：

```json
{"level":"error","msg":"db query failed","err":"context deadline exceeded",
 "trace_id":"abc123","sql":"select ...","duration_ms":3000}
```

**没有结构化就按关键字搜**：

```bash
# 按时间窗
grep "2026-11-27 10:2" app.log | grep -i error

# 按 trace id 串起全链路
grep "abc123" *.log

# 统计错误类型
grep -oE '"err":"[^"]*"' app.log | sort | uniq -c | sort -rn | head
```

**"统计错误类型"这一步很关键**：它告诉你"是同一个错刷屏，还是很多种错"。

```
同一个错刷屏 → 一个根因（如依赖挂了）
很多种错     → 可能是过载/资源不足导致连锁失败
```

### 线程卡死：进程在但不干活

```bash
# Java
jstack <pid> > /tmp/stack.txt
grep -A 30 "BLOCKED\|WAITING" /tmp/stack.txt | head -60

# 看线程状态分布
grep -oE "java.lang.Thread.State: [A-Z_]+" /tmp/stack.txt | sort | uniq -c
```

**判读**：

```
大量 BLOCKED 在同一把锁 → 锁竞争/死锁
大量 WAITING 在同一个 socket read → 依赖不响应
大量 RUNNABLE 且 CPU 高 → 真的在算（可能死循环）
```

**Go 更方便**：

```bash
kill -QUIT <pid>       # 打印所有 goroutine 栈到 stderr（日志里能看到）
```

**通用**：

```bash
cat /proc/<pid>/status | grep Threads
ls /proc/<pid>/task | wc -l
```

### 连接池：最常被忽略的瓶颈

**症状**：

```
请求排队，应用日志没有明显错误
DB 侧连接数很高，但 QPS 不高
```

**检查**：

```bash
# 数据库侧
show status like 'Threads_connected';
show status like 'Threads_running';
show variables like 'max_connections';
```

**判读**：

```
Threads_connected 接近 max_connections → 连接数打满
Threads_running 高 → 慢查询堆积
```

**应用侧的三个参数**（以常见连接池为例）：

```
maximumPoolSize     最大连接（不是越大越好）
connectionTimeout   拿连接的超时（设太大会导致请求堆积）
idleTimeout         空闲回收
```

**常见错误配置**：

```
maximumPoolSize = 100，应用 20 个实例 → DB 上 2000 连接
→ 超过 max_connections → "Too many connections"
```

**正确算法**：

```
总连接 = 实例数 × 每实例池大小
应 ≤ DB max_connections × 0.8
```

### 慢查询：从日志到执行计划

```sql
-- MySQL
SHOW FULL PROCESSLIST;                 -- 正在跑的
SELECT * FROM performance_schema.events_statements_history_long
 ORDER BY timer_wait DESC LIMIT 5;

-- 慢日志
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 1;
```

**拿到慢 SQL 后用 EXPLAIN**：

```sql
EXPLAIN ANALYZE SELECT ...;
```

**看三处**：

```
① type       ALL / index → 全表扫（要加索引）
② rows       扫描行数（远大于返回行数 = 索引不对）
③ Extra      Using filesort / Using temporary → 排序/临时表开销
```

### 依赖调用的三个反模式

**① 无超时**

```python
requests.get(url)      # 默认无超时 → 一直挂
requests.get(url, timeout=(3, 10))   # 连接 3s，读 10s
```

**② 无重试上限 / 无退避**

```
下游抖动 → 应用重试 → 下游更抖 → 雪崩
```

正确：**指数退避 + 抖动 + 上限**（如 3 次，1s/2s/4s + 随机）。

**③ 重试不幂等**

```
写请求重试 → 重复下单
→ 需要幂等键（request_id）或去重表
```

### 一次"随机 502"的排查

**现象**：每小时有几次 502，其他时间正常。

```
① 网关日志：upstream prematurely closed connection
   → 后端主动断开了连接（不是超时）

② 后端日志：没有异常
   → 说明不是应用抛错

③ 抓包：看到后端在收到请求后立刻发 RST
   → 后端的 keepalive 超时比网关短

④ 结论：网关复用了后端已关闭的连接（keepalive 时间不匹配）
```

**修复**：

```
后端 keepalive timeout > 网关的 keepalive timeout
（通常后端设为网关的 1.5 倍）
```

**这个案例的通用教训**：

```
连接复用场景下，"随机断开"多半是两端 keepalive 时间不匹配
```

### 检查清单

```
□ 用状态码先定位层（499/502/504/500）
□ 日志按时间窗 + trace_id + 错误类型统计
□ 线程栈看状态分布（BLOCKED/WAITING/RUNNABLE）
□ 连接池总连接 ≤ DB max_connections × 0.8
□ 慢 SQL 用 EXPLAIN ANALYZE 看 type/rows/Extra
□ 依赖调用必须有超时
□ 重试有退避与上限
□ 写请求重试要幂等
□ keepalive 时间两端匹配（后端 > 网关）
```
