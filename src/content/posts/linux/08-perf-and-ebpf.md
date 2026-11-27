---
title: perf 与 eBPF：定位"看不出原因"的性能问题
description: 采样火焰图怎么读、perf 的四个常用子命令、eBPF 能回答哪些 strace 回答不了的问题，附一次真实的 CPU 飙高排查。
date: 2026-11-27
tags: [Linux, 性能, perf, eBPF, 火焰图]
---

### 什么时候需要 perf / eBPF

前面那些工具（top、vmstat、iostat、pidstat）能告诉你**哪里慢**：CPU 高、IO 高、上下文切换多。但再往下，"到底是代码里哪一行在烧 CPU""sys 时间为什么这么高"，它们答不了。

这时需要：

- **perf**：采样内核与用户态的调用栈，出火焰图。
- **eBPF**：在内核里挂探针，观测"谁调用了什么、耗时多少、参数是什么"，开销极低。

### perf 的四个子命令

```bash
# ① 实时看热点函数（默认按周期采样）
perf top -p 12345

# ② 采集 30 秒，生成报告
perf record -F 99 -p 12345 -g -- sleep 30
perf report

# ③ 统计系统调用与事件计数
perf stat -e cycles,instructions,cache-misses -p 12345 -- sleep 5

# ④ 采集整个系统（不指定 PID），需要 root
perf record -F 99 -a -g -- sleep 30
```

`-F 99` 是采样频率（99Hz），选 99 而不是 100 是为了避免与某些定时器共振。

### 火焰图怎么读

```bash
perf record -F 99 -a -g -- sleep 30
perf script > out.perf
# 用 FlameGraph 工具链
stackcollapse-perf.pl out.perf > out.folded
flamegraph.pl out.folded > cpu.svg
```

读法三条：

1. **横轴宽度 = 占用时间比例**，不是调用顺序。
2. **看最宽的"平顶"**：哪一层的块特别宽，就是它自己在烧 CPU（而不是它的子调用）。
3. **从上往下看"叶子"**：最顶端的帧是真正在执行的函数。

典型图景：

- 叶子是 `memcpy` / `__memmove_avx` 且很宽 → 大量数据拷贝，检查是不是反复复制大对象。
- 叶子是 `malloc` / `free` → 分配器压力大，看是不是短生命周期对象太多。
- 叶子是 `__lock_acquire` / `futex` → 锁竞争，扩大临界区或换无锁结构。
- 叶子是 `syscall` 且下面全是 `[unknown]` → 系统调用占比高，需要 eBPF 看是哪个 syscall。

### 用户态没栈？先修符号

Java、Go、Python 常常只看到 `[unknown]`。原因与修法：

| 语言 | 需要什么 |
| --- | --- |
| C/C++ | 编译带 `-g`，或装 `-debuginfo` 包 |
| Java | `-XX:+PreserveFramePointer`，配合 async-profiler 更佳 |
| Go | 默认有符号，但需 `perf record -g` 且 binary 不要 strip |
| Python | 需要 `python-perf`/`py-spy`，perf 对 CPython 支持有限 |

Java 场景直接用 async-profiler 更省事，它按 Java 栈采样，不依赖 perf 的 frame pointer。

### eBPF：回答 strace 回答不了的

`strace` 的问题：**开销大**（每个 syscall 两次上下文切换），生产环境不敢长时间挂。

eBPF 的 `bcc`/`bpftrace` 可以低开销地回答：

```bash
# 谁在打开文件、打开失败的原因
bpftrace -e 'tracepoint:syscalls:sys_enter_openat { printf("%s %s\n", comm, str(args->filename)); }'

# 按进程统计 syscall 数与耗时（bcc 工具）
execsnoop          # 谁在频繁 fork/exec（常见于脚本写错）
opensnoop          # 文件打开追踪
biolatency         # 块设备 IO 延迟分布
tcpretrans         # TCP 重传
runqlat            # 运行队列等待（CPU 排队时间）
tcpconnect         # 所有出向连接
```

四个最常用的诊断组合：

```bash
# ① 延迟抖动，但 CPU 不高 → 看 runqlat 与 biolatency
runqlat 10 1
biolatency -m

# ② 网速慢但带宽没满 → 看 tcpretrans 与 tcplife
tcpretrans

# ③ 进程莫名消失 → 看 OOM 与 signal
bpftrace -e 'tracepoint:signal:signal_generate { printf("%d -> %d %s\n", args->pid, args->sig, args->comm); }'

# ④ 谁在写日志/写文件太多 → 看 vfs_write 调用方
bpftrace -e 'kprobe:vfs_write { @[comm] = count(); }'
```

### 一次真实排查：CPU 高但分成两半

现象：某个 Go 服务 CPU 打满一核，QPS 却掉了一半。

```
top → 单核 100%，us 60% sy 40%
```

**第一步：分成两半**。`sy` 40% 说明内核态消耗异常，正常服务 sy 通常在 10–15%。

```bash
perf top -p <pid>
```

看到：

```
  28% [kernel] __copy_user_64
  18% [kernel] tcp_sendmsg
  12% [kernel] __tcp_transmit_skb
```

`__copy_user` 高说明**大量数据从用户态拷到内核态**——典型原因是每次写响应都做了小包 send。

**第二步：验证**。

```bash
bpftrace -e 'kprobe:tcp_sendmsg { @bytes = hist(args->size); }' -p <pid>
```

直方图显示绝大多数包 < 200 字节。而应用逻辑是"循环里逐条 send"。

**第三步：修**。改成攒批发送（bufio Writer 或合并 JSON 数组），sys 时间从 40% 降到 8%，QPS 翻倍。

结论：**没有 perf 分栈，根本猜不到"用户态 CPU 归因到内核拷贝"这条路**。这就是采样工具的价值。

### 安全与权限

- eBPF 需要 `CAP_BPF` / root。生产上用受限的 bcc 工具集，不要让业务能随意挂探针。
- `perf` 有 `perf_event_paranoid` 限制：

```bash
cat /proc/sys/kernel/perf_event_paranoid
# -1 全部允许；2 只允许用户态；3 禁止
```

容器里跑 perf 常常因这个返回 `Permission denied`，需要 `--cap-add=SYS_ADMIN` 或调低 paranoid。

### 落地建议

1. 在预发环境装好 `perf`、`async-profiler`、`bcc-tools`，**故障时再装来不及**。
2. 把火焰图生成脚本固化，一条命令出图。
3. 给关键服务常开低频采样的 CPU profile（1% 采样），出事有历史数据可对比。
4. 定期看 `runqlat` 与 `biolatency` 的基线，偏离基线就是信号。
