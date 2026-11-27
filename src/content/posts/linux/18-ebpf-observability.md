---
title: 用 eBPF 看清系统：不重启、不埋点也能观测
description: bpftrace 十行脚本解决常见问题、bcc 工具速查、以及五个"eBPF 也不是万能"的边界。
date: 2026-11-27
tags: [Linux, 可观测, eBPF]
---

### 它凭什么好用

```
① 内核态执行，开销低
② 不需要改代码、不用重启
③ 能看到"系统调用/函数级"的真相
```

**"进程到底卡在哪个系统调用"** 是传统工具（top/iostat）答不了的问题。

### bpftrace 五条立即可用

**① 谁在打开文件**

```bash
bpftrace -e 'tracepoint:syscalls:sys_enter_openat { printf("%s %s\n", comm, str(args->filename)); }'
```

**② 哪个进程在疯狂 syscall**

```bash
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'
```

**③ 文件读取延迟分布**

```bash
bpftrace -e '
tracepoint:syscalls:sys_enter_read { @start[tid] = nsecs; }
tracepoint:syscalls:sys_exit_read /@start[tid]/ {
  @us = hist((nsecs - @start[tid]) / 1000);
  delete(@start[tid]);
}'
```

**④ DNS 查询慢在哪**

```bash
bpftrace -e '
kprobe:udp_sendmsg { @[comm] = count(); }
interval:s:5 { print(@); clear(@); }'
```

**⑤ TCP 重传**

```bash
bpftrace -e 'kprobe:tcp_retransmit_skb { @[comm, kstack] = count(); }'
```

**"十行以内解决问题"** 是 bpftrace 的最大优势。

### bcc 工具速查

```bash
execsnoop            # 实时新进程（抓"谁在偷偷起进程"）
opensnoop            # 打开的文件
biolatency           # 块设备 IO 延迟直方图
biosnoop             # 每次 IO 的进程/偏移/延迟
tcpretrans           # TCP 重传
tcplife              # 连接生命周期
gethostlatency       # DNS 解析延迟
profile              # CPU 采样（火焰图数据）
offcputime           # 谁让 CPU 空转等待
runqlat              # 调度延迟
cachestat            # 页缓存命中
```

**排障顺序常用**：

```
① execsnoop（有没有意外进程）
② biolatency（磁盘慢不慢）
③ runqlat（是不是 CPU 争抢）
④ offcputime（卡在哪）
⑤ gethostlatency（DNS）
```

### 火焰图

```bash
# CPU 火焰图
profile-bpfcc -af 30 > out.stacks
flamegraph.pl out.stacks > cpu.svg

# off-CPU（阻塞）火焰图
offcputime-bpfcc -df 30 > off.stacks
flamegraph.pl --color=io off.stacks > off.svg
```

**"CPU 火焰图看'算得久'，off-CPU 火焰图看'等得久'"** —— 后者更能解释"CPU 不高但很慢"。

### 五个边界（eBPF 不是万能）

**① 内核版本要求**

```
老内核（< 4.9）不支持，或功能受限
CentOS 7（3.10）需要 BCC 的兼容层，部分工具不可用
```

**② 需要特权**

```
需要 CAP_BPF / CAP_SYS_ADMIN
→ 容器里跑通常需要 privileged 或特定 capabilities
```

**③ 对用户态函数需要符号**

```
uprobe 需要二进制带符号（strip 过的会失败）
```

**④ 有性能上限**

```
高频事件（每次 syscall 都跑脚本）会明显拉高 CPU
→ 用过滤器 + 聚合（@map），别 printf 每个事件
```

**⑤ 不能替代业务埋点**

```
"为什么这个业务分支慢" —— eBPF 看不到业务语义
```

### 一个"排障实战"组合

**现象**：应用 P99 从 50ms 涨到 800ms，CPU 只有 20%。

```
① runqlat → 调度延迟正常
② biolatency → 磁盘延迟上升（p99 40ms）
③ biosnoop → 看到某进程大量随机读
④ 定位到"日志文件被频繁 fsync"
⑤ 结论：日志同步写导致 IO 放大
```

**"CPU 不高但慢" → 一定在等什么（IO/锁/网络/调度）**，eBPF 能直接指出来。

### 生产使用的注意

```
① 先在测试环境验证脚本（避免卡内核）
② 加超时（bpftrace 用 `-d` 或外部 timeout）
③ 脚本要能"可重复执行"（不要依赖残留状态）
④ 记录"跑了什么脚本、结论是什么"（别只截图）
```

**"在线上跑一个没有超时的 bpftrace"** 有把机器拖住的风险。

### 检查清单

```
□ 内核版本 ≥ 4.9（最好 ≥ 5.4）
□ 有 bpftrace / bcc 可用
□ 能用 execsnoop/biolatency/runqlat 三板斧
□ 会看 CPU 与 off-CPU 两种火焰图
□ 脚本有聚合与过滤（不 printf 每事件）
□ 有超时保护
□ 容器场景确认 capabilities
□ 不把它当业务埋点替代品
□ 排障结论有记录（脚本+现象+根因）
```
