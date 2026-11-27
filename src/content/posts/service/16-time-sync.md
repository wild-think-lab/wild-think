---
title: 时间同步体系：一次 NTP 偏移引发的五个故障
description: NTP 与 chrony 的选择、层级与漂移原理、容器与虚拟机的时间问题、以及"证书校验失败"这类看似无关故障的真实根因。
date: 2024-09-01
tags: [NTP, 时间同步, chrony, 运维]
---

### 为什么时间这么重要

时钟偏差会引发一串"看起来无关"的故障：

| 偏差 | 表现 |
| --- | --- |
| > 5 分钟 | TLS 证书校验失败（"证书未生效"） |
| > 1 分钟 | Kerberos/AD 认证失败（票据过期） |
| > 几秒 | 分布式锁误判、日志顺序错乱 |
| 毫秒级 | 分布式追踪的 span 顺序错、指标聚合异常 |

**一个真实的案例链**：某主机时间快了 8 分钟 → 调用 HTTPS 接口报证书错误 → 开发者以为是证书问题 → 排查 2 小时 → 最后发现是 NTP 没配对。

### NTP vs chrony

| | ntpd | chrony |
| --- | --- | --- |
| 收敛速度 | 慢（可能几小时） | 快（分钟级） |
| 对间歇网络 | 差 | 好（适合虚拟机/移动设备） |
| 资源占用 | 略高 | 低 |
| 现状 | 老 | **现代发行版默认** |

**结论**：新系统一律用 chrony（CentOS 8+/Ubuntu 20.04+ 默认）。

### chrony 配置

**服务端（内网时间源）** `/etc/chrony.conf`：

```conf
# 上游
pool ntp.aliyun.com iburst
pool cn.pool.ntp.org iburst

# 允许内网客户端同步
allow 10.0.0.0/24

# 本机若失去上游，仍作为时间源提供服务
local stratum 10

# 漂移补偿（首次运行后生成）
driftfile /var/lib/chrony/drift
makestep 1.0 3
rtcsync
```

**客户端**：

```conf
server 10.0.0.5 iburst
driftfile /var/lib/chrony/drift
makestep 1.0 3          # 前 3 次校正允许直接跳变
rtcsync
```

`makestep 1.0 3` 的含义：前 3 次校正中，若偏差 > 1 秒就直接跳（而不是慢慢调），否则启动时要等很久才对齐。

### 验证

```bash
chronyc sources -v
#  MS Name/IP address   Stratum Poll Reach LastRx Last sample
#  ^* 10.0.0.5              2   6   377    32   -12us[ -15us] +/-  2ms
```

判读符号：

| 符号 | 含义 |
| --- | --- |
| `^*` | 当前选中的同步源（正常） |
| `^+` | 备选可用 |
| `^-` | 被排除 |
| `^?` | 不可达/未同步 |

```bash
chronyc tracking
# Reference ID    : 0A000005 (10.0.0.5)
# Stratum         : 3
# System time     : 0.000012 seconds fast of NTP time
# Last offset     : +0.000008 seconds
# Root delay      : 0.002 seconds
```

关键看 `System time` 的偏移量，**应在毫秒级以内**。

```bash
timedatectl
# System clock synchronized: yes
# NTP service: active
```

### 层级（stratum）与拓扑

```
Stratum 0：原子钟/GPS（不直接连网络）
Stratum 1：直连 stratum 0 的服务器
Stratum 2：从 stratum 1 同步（大多数公网 NTP）
Stratum 3+：逐级往下
```

内网设计：

```
公网 NTP（2 个，不同来源）
      ↓
内网时间服务器（2 台，互为备份）
      ↓
所有业务服务器（指向内网，不直连公网）
```

**为什么不让所有机器直连公网**：外网抖动会导致全站时间抖动，且公网 NTP 有速率限制。

### 虚拟机与容器的时间问题

**虚拟机**：

```
① 宿主机的时钟不稳定 → VM 时钟漂移
② 快照恢复后时钟错乱（恢复到过去的时间点）
③ vCPU 抢占导致时钟跳跃
```

对策：VM 内部仍要跑 chrony（不要只靠宿主机同步），且恢复快照后立即 `chronyc makestep`。

**容器**：

```
容器共享宿主机的内核时钟，所以：
- 容器内不需要跑 NTP
- 但容器内看到的时区由镜像决定（UTC vs CST）
```

时区问题：

```dockerfile
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone
```

**容器时间对但时区错**是最常见的"日志时间差 8 小时"。

### 四个常见故障

**① "证书未生效"**

```
报错：certificate is not yet valid
原因：客户端时间比证书生效时间还早
验证：date -u; openssl s_client -connect example.com:443 | openssl x509 -noout -dates
```

**② "AD 登录失败"**

Windows 域内时间偏差 > 5 分钟 → Kerberos 拒绝。域控制器通常是时间源，成员机要指向它。

```powershell
w32tm /query /status
w32tm /resync
```

**③ "日志时间顺序错乱"**

多台机器时间不一致，日志聚合后顺序乱 → 排障时误判因果。

**④ "定时任务重复执行"**

集群里两台机器时间差几秒，同一时刻的 cron 都触发了 → 任务跑两遍。

### 监控

```bash
# 偏移量导出给 Prometheus（node_exporter textfile）
chronyc tracking | awk '/System time/ {print "node_time_offset_seconds " $4}' \
  > /var/lib/node_exporter/textfile/time.prom
```

告警：

```yaml
- alert: ClockSkew
  expr: abs(node_time_offset_seconds) > 0.5
  for: 5m
  labels: { severity: warning }
```

**阈值 0.5 秒**：超过就该查了，超过 5 秒基本一定会引发认证/证书问题。

### 检查清单

```
□ 所有服务器都有 chrony/ntpd 且 enabled
□ 内网有 2 台时间服务器，互为备份
□ 业务机只指向内网时间源
□ chronyc tracking 的偏移 < 100ms
□ 容器镜像设了 TZ
□ 快照恢复后手动 makestep
□ 有时间偏移告警（> 0.5s）
```
