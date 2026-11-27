---
title: Linux 运维高频面试题：结论、原理、追问三层答法
description: 同一个问题，回答"是什么"只能及格，讲清"为什么"和"边界在哪"才算合格。这里给的是可以直接背下来的答题结构。
date: 2026-11-06
tags: [面试, Linux, 运维, 内核]
---

面试官问的每一个技术问题，本质都在测三件事：**你知不知道结论、你懂不懂原理、你有没有踩过坑**。按三层准备，比背题库有效。

## 一、进程与内存

### Q：进程和线程的区别？

**结论**：进程是资源分配的单位，线程是 CPU 调度的单位；同进程线程共享地址空间，进程隔离。

**原理**：Linux 里其实不严格区分——线程是共享同一 `mm_struct` 的"轻量级进程"（LWP），`clone()` 时通过共享标志决定共享哪些资源。所以 `ps -efL` 能看到同 PID 下多个 LWP 的 TID。

**追问**：为什么容器里 `nproc` 看到的是宿主机 CPU 数？——`nproc` 读 `/proc/cpuinfo`，不受 cgroup 限制；要看限额得读 `cgroup` 的 `cpu.max` 或用 `lscpu`/`/sys/fs/cgroup`。

### Q：内存不足时会发生什么？

**结论**：先回收 page cache，再触发 swap，最后 OOM Killer 按 `oom_score` 杀进程。

**原理**：`vm.overcommit_memory` 控制是否允许超量分配；`oom_score_adj` 可调权重（-1000 到 1000）。容器场景杀的是"cgroup 内最重的进程"，不是全系统最重。

**追问**：为什么 `free` 显示内存快满了但服务没挂？——`available` 才算真正可用，`buff/cache` 可回收；看 `free -m` 的 `available` 列，不看 `free` 列。

## 二、I/O 与负载

### Q：`load average` 高就说明 CPU 忙吗？

**结论**：不一定。load 统计的是**运行中 + 不可中断睡眠（D 状态）**的进程数，磁盘 I/O 阻塞同样会推高 load。

**原理**：内核每 5 秒采样一次，`/proc/loadavg` 给 1/5/15 分钟指数平滑值。

**追问**：怎么快速判断是高 CPU 还是 I/O 阻塞？——`vmstat 1` 看 `r`（可运行队列）与 `b`（阻塞）列，配合 `iostat -x 1` 看 `%util` 与 `await`；`ps -eo stat,pid,comm | grep ' D'` 直接列 D 状态进程。

### Q：磁盘 I/O 慢怎么定位？

**结论**：先分"应用层随机小 I/O"与"存储层饱和"，再定位到具体进程与文件。

```bash
iostat -x 1 5           # %util 接近 100 = 设备饱和；await 高 = 排队
iotop -oPa              # 按进程看实际 I/O
pidstat -d 1            # 每进程读写速率
cat /proc/<pid>/io      # 累计读写字节
```

**追问**：SSD 上 `%util` 100% 就是瓶颈吗？——不一定，SSD 并发能力强，`%util` 的语义在 NVMe 上失真，要看 `await`、`aqu-sz`（队列深度）与设备自身的 `latency`。

## 三、服务与启动

### Q：systemd 服务起不来如何排查？

**结论**：四步——`status` 看退出码、`journalctl -u` 看日志、`systemd-analyze verify` 校验单元、手动跑 ExecStart。

```bash
systemctl status myapp -l --no-pager
journalctl -u myapp -n 100 --no-pager
systemd-analyze verify /etc/systemd/system/myapp.service
```

**追问**：`ExecStart` 里的相对路径为什么不行？——systemd 不经过 shell，没有 PATH 展开与通配符，必须绝对路径；要 shell 特性得写 `ExecStart=/bin/bash -c '...'`。

### Q：服务能起但访问不通，怎么分？

**结论**：按"进程是否监听 → 防火墙是否放行 → 网络是否可达 → 应用是否响应"四层剥离。

```bash
ss -lntp | grep :80        # 1 监听
firewall-cmd --list-all     # 2 本机策略
nc -zv host 80              # 3 连通性
curl -v http://host/        # 4 应用层
```

**追问**：`ss` 有监听但 `curl` 拒连？——检查 `bind` 地址是不是 `127.0.0.1`，以及是否被 `iptables` 的 `REJECT` 拦在本机。

## 四、文件与权限

### Q：`Permission denied` 但权限看起来正常？

**结论**：优先查父目录执行位、ACL、SELinux 上下文、挂载选项。

```bash
namei -l /a/b/c        # 逐级权限
getfacl /a/b/c
ls -Z /a/b/c
findmnt -T /a/b/c
```

**追问**：`ls -l` 权限位后面有个 `+` 是什么意思？——存在 ACL，此时三位权限不是全部规则。

## 五、网络与内核参数

### Q：`TIME_WAIT` 很多要紧吗？

**结论**：主动关闭方进入 TIME_WAIT 是正常行为；大量 TIME_WAIT 说明短连接多，优先改**连接复用**而不是调内核参数。

**原理**：TIME_WAIT 持续 2MSL（默认 60s），保证最后一个 ACK 能重传、旧连接不会串到新连接。

**追问**：`net.ipv4.tcp_tw_reuse` 能开吗？——客户端侧可开（复用出向连接），服务端不要靠它解决；`tcp_tw_recycle` 在 NAT 环境下会导致丢包，现代内核已移除。

## 六、答题模板

任何一个问题，按这个结构答：

1. **一句话结论**（先给判断，别铺垫）
2. **背后的机制**（内核/协议层怎么实现的）
3. **验证方式**（你会用哪个命令确认）
4. **边界与坑**（什么情况下这个结论不成立）

> 面试官真正想听的是第 3 和第 4 层——那才证明你操作过，而不是读过。
