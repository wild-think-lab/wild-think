---
title: Linux 性能分析速查
summary: 按 CPU、内存、磁盘、网络四类给出"先看什么、再看什么"的顺序，每条命令附判读阈值。
group: Linux
order: 4
tags: [性能, linux, 排障]
---

## 一、一分钟体检（黄金六条）

```bash
uptime                 # 负载（1/5/15 分钟）
dmesg | tail -20       # OOM、磁盘错误
vmstat 1 5             # r(运行队列) b(阻塞) si/so(swap)
mpstat -P ALL 1 3      # 每核 CPU
pidstat 1 5            # 每进程 CPU
iostat -xz 1 5         # 磁盘 %util / await
sar -n DEV 1 5         # 网络吞吐
```

**判读顺序**：先看 `vmstat` 的 `r` 与 `b`（是不是有排队），再看是 CPU 还是 IO 造成的。

## 二、CPU

```bash
top -o %CPU                        # 谁在耗
mpstat -P ALL 1 3                  # 是否单核打满（多线程不均）
pidstat -u 1 5                     # 每进程
pidstat -t -p <pid> 1 5            # 每线程（找热点线程）
perf top                           # 内核级热点函数
```

| 指标 | 健康 | 说明 |
| --- | --- | --- |
| `%us` 高 | — | 用户态计算多（应用问题） |
| `%sy` 高 | — | 系统调用多（IO 频繁、锁竞争） |
| `%wa` 高 | < 5% | 等 IO（看磁盘） |
| `%st` 高 | 0 | 虚拟机被宿主机抢（该扩容或换宿主） |
| load > 核数 | — | 有排队 |

**`%st` 是虚拟机的隐形杀手**：看起来 CPU 空闲但应用很慢。

## 三、内存

```bash
free -h                            # available 才是可用
cat /proc/meminfo | head -20
vmstat 1 5                         # si/so 非 0 → 在换页
smem -rk                           # 按进程看实际占用（含共享）
ps aux --sort=-rss | head -10
```

| 指标 | 判读 |
| --- | --- |
| `available` < 10% | 内存紧张 |
| `si/so` 非 0 | 在用 swap，性能会断崖下降 |
| `buff/cache` 大 | 正常（可回收），不是"被占用" |
| `dmesg` 有 `Out of memory` | 有进程被 OOM 杀 |

**排查泄漏**：

```bash
# 观察 RSS 是否持续增长
pidstat -r -p <pid> 5 10
```

## 四、磁盘 IO

```bash
iostat -xz 1 5
iotop -o                           # 谁在读写
pidstat -d 1 5                     # 每进程 IO
df -hT; df -i                      # 空间与 inode
lsof +L1                           # 已删除但被占用的文件
```

| 指标 | 机械盘 | SSD |
| --- | --- | --- |
| `await` | < 20ms | < 5ms |
| `%util` | < 70% | < 90% |
| `r/s w/s` | 看是否接近 IOPS 上限 | — |

**`%util` 100% 不一定慢**（SSD/RAID 有队列并行），`await` 更能反映真实延迟。

## 五、网络

```bash
sar -n DEV 1 5                     # 每网卡吞吐
ss -s                              # 连接数总览
ss -tunap | head -30               # 谁连谁
netstat -s | grep -E 'retrans|drop'  # 重传/丢包
tcpdump -i eth0 -nn -c 50 port 8080
```

| 指标 | 判读 |
| --- | --- |
| `retrans` 持续增长 | 丢包或链路差 |
| `ss -s` 的 TIME-WAIT 很多 | 短连接多，考虑连接复用 |
| `receive/send buffer errors` | 内核缓冲不足 |

## 六、定位一条"系统慢"的路径

```
① uptime / vmstat → 有没有排队（r 大 / b 大）
② 若 r 大 → CPU 满：mpstat 看是哪类（us/sy/wa/st）
③ 若 b 大 → IO 阻塞：iostat 看哪块盘、哪个进程（iotop）
④ 若 si/so 非 0 → 内存不足
⑤ 都不高但应用慢 → 看网络（延迟/重传）与下游依赖
```

## 七、perf 与 eBPF（进阶）

```bash
# CPU 火焰图
perf record -F 99 -a -g -- sleep 30
perf script | stackcollapse-perf.pl | flamegraph.pl > cpu.svg

# 找长阻塞的 IO
perf trace -T -- sleep 5

# eBPF（bcc 工具集）
execsnoop                          # 新进程
biolatency                         # IO 延迟分布
tcpretrans                         # TCP 重传
opensnoop                          # 打开的文件
```

`biolatency` 输出的延迟分布，比 `iostat` 的平均值更能说明问题（能看出"偶发长尾"）。

## 八、常见现象对照

| 现象 | 首查 |
| --- | --- |
| 负载高但 CPU 空闲 | IO 阻塞（`vmstat b` 大）或 D 状态进程 |
| CPU 不高但很慢 | `%st`（虚拟机）、锁竞争、下游慢 |
| 内存够但被 OOM | cgroup 限制、页缓存挤占 |
| 磁盘空间够但写失败 | inode 满（`df -i`） |
| 一切正常但网络慢 | 重传、MTU、DNS 解析 |
| 进程杀不掉（D 状态） | 等 IO/等锁（`cat /proc/<pid>/stack`） |

## 九、检查清单

```
□ 先跑"黄金六条"再深入
□ 区分 CPU 满 / IO 阻塞 / 内存不足 / 网络问题
□ 看延迟（await）而不是只看 %util
□ 用 pidstat -t 找热点线程
□ %st 高要怀疑虚拟化层
□ 用 biolatency 看长尾而不是平均
```
