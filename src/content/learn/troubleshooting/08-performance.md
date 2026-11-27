---
title: 性能问题排查：CPU / 内存 / IO / 网络
module: 熟练篇
summary: 四类资源瓶颈的判定命令与典型结论，以及"应用慢但资源不高"的三种真实原因。
minutes: 50
---

### 先判定是哪一类

```bash
top -b -n1 | head -15
vmstat 1 5
iostat -x 1 3
sar -n DEV 1 3
```

**判据表**：

| 指标 | 高说明 |
| --- | --- |
| us 高 | 计算密集（代码/算法） |
| sy 高 | 系统调用/上下文切换过多 |
| wa 高 | IO 等待（磁盘/网络存储） |
| free 低 + si/so | 内存不足在换页 |
| %util 接近 100 | 磁盘饱和 |

### CPU 高怎么定位

```bash
top -H -p <pid>            # 找热点线程
pidstat -u -p <pid> 1 3
# Java
jstack <pid> > /tmp/js.txt   # 看 RUNNABLE 线程
```

**典型结论**：

```
① 单线程死循环 → 一个线程 100%
② GC 频繁 → jstat -gcutil 看 FGC 次数
③ 正则回溯/大循环 → 代码问题
```

### 内存问题两种

```
① 泄漏：RSS 持续上涨不回落 → 拿堆 dump/pprof
② 不足：被 OOM kill → dmesg | grep -i oom
```

```bash
dmesg | grep -i "killed process"
ps -o pid,rss,cmd --sort=-rss | head
```

**注意**：容器里看的是 cgroup 限额，不是宿主机 free。

```bash
cat /sys/fs/cgroup/memory.max
cat /sys/fs/cgroup/memory.current
```

### IO 问题

```bash
iostat -x 1 3        # await / %util / aqu-sz
iotop -o             # 谁在写
pidstat -d 1 3
```

**典型结论**：

```
① 日志同步写（fsync）→ 改异步/批量
② 大文件拷贝/备份与业务抢盘
③ 云盘 IOPS 上限（看云监控）
```

### 网络问题

```bash
ss -s                      # 总览（TIME_WAIT 是否爆）
ss -ant state established | wc -l
sar -n TCP,ETCP 1 3
mtr -n <目标>              # 逐跳丢包
tcpdump -i eth0 -n port 8080 -c 50
```

**典型结论**：

```
① 丢包/重传 → 链路或带宽
② 连接数打满 → 端口耗尽/连接泄漏
③ DNS 解析慢 → 每次请求都在解析
```

### "应用慢但资源不高"的三种真实原因

```
① 等锁/等连接池（线程都 BLOCKED）
② 等下游（DB/第三方接口超时）
③ 排队（线程池满，请求在队列里等）
```

```bash
# Java 看线程状态分布
grep -c "java.lang.Thread.State: BLOCKED" /tmp/js.txt
```

**判据**：CPU 不高 + 延迟高 = 一定在"等"，找出等什么。

### 五个"看错指标"

**① 只看平均值**

```
P99 才是用户体验
```

**② 看宿主机不看容器**

```
容器限额到了，宿主机很闲
```

**③ 单次采样**

```
瞬时值 vs 持续趋势
```

**④ 忽略上下文切换**

```
sy 高但 us 不高 → 锁竞争/线程过多
```

**⑤ 把 GC 当 CPU 问题**

```
实际是内存配置问题
```

### 检查清单

```
□ 先分类（CPU/内存/IO/网络）
□ 用 1 秒粒度多次采样
□ 看 P95/P99 而不是均值
□ 容器看 cgroup 限额
□ 线程状态分布（等锁/等 IO）
□ 下游耗时（别只盯自己）
□ 记录基线（正常时什么样）
□ 优化前后有对比数据
□ 结论写进知识库
□ 补上对应监控
```
