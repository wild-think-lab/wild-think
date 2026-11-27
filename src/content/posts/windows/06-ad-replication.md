---
title: AD 域复制排障：dcdiag、repadmin 与"为什么用户登不进来"
description: 复制的三个通道、站点与桥头堡、dcdiag 输出怎么读、repadmin 五条命令、USN 回滚与墓碑时间，以及客户端登录失败的排查顺序。
date: 2023-04-06
tags: [AD, 域控, 复制, Windows, 排障]
---

### 复制的三条通道

Active Directory 的复制分三类，出问题时要先分清是哪一类：

| 通道 | 内容 | 工具 |
| --- | --- | --- |
| 域内（intra-site） | 同一站点的 DC 之间 | `repadmin /replsummary` |
| 域间（inter-site） | 跨站点，按站点链接开销调度 | `repadmin /showrepl`、`/bridgeheads` |
| 跨域/跨林 | 不同域之间的信任与引用 | `repadmin /showrepl * /csv` 全扫 |

同站点默认 15 秒内触发（变更通知），跨站点按链接开销与计划（默认最小 15 分钟）。

### 先看整体健康度

```powershell
repadmin /replsummary
```

输出四块：**largest delta**（最大延迟）、**fails/total**（失败数）、**error**（错误码）。看到 `fails > 0` 就先修复制，别查业务。

```powershell
dcdiag /v /c /d /e /s:DC01 > dcdiag.txt
```

`/v` 详细、`/c` 全部测试、`/e` 全企业、`/s` 指定从哪台执行。

`dcdiag` 里最该关注的四项：

- **Connectivity**：能不能连到其他 DC 的 RPC 端口（135、389、3268、49152+ 动态端口）
- **Replications**：复制是否成功
- **Advertising**：DC 是否在向客户端"广告"自己（`netlogon` 服务）
- **SysvolCheck**：SYSVOL 共享是否一致

### 五条最常用的 repadmin

```powershell
repadmin /showrepl DC01                        # 入站邻居与最近一次成功
repadmin /replsummary                          # 全局概览
repadmin /showrepl * /csv > repl.csv            # 导出全量，便于对比
repadmin /queue DC01                           # 待复制队列（积压说明有故障）
repadmin /showbackup DC01                       # 备份时间（超过墓碑期就有风险）
```

判读 `showrepl`：

```
DC=corp,DC=local
  DC02\CORP via RPC
    DSA object GUID: ...
    Last attempt @ 2026-11-27 09:12:03 was successful.
```

出现 `Last attempt ... failed, result 8453`（**8453 = 复制访问被拒绝**）通常是权限或防火墙；`8524` 是 DNS 解析问题；`8614` 是"目标 DC 上的 USN 比源大"，也就是**USN 回滚**。

### 三个致命的时间概念

**① Tombstone Lifetime（墓碑期）**：删除的对象在域里保留多久（现代默认 180 天）。**离线超过墓碑期的 DC 不能直接重新加入**，必须强制降级后重装。

**② USN 回滚**：从旧备份恢复 DC，导致它的 USN 比同伴小。同伴会拒绝复制（8614）。修复手段：

```powershell
# 在"源 DC"（USN 较大的那台）上
repadmin /showutdvec DC01 dc=corp,dc=local
# 在"目标 DC"（被恢复的那台）上
repadmin /options DC02 +DISABLE_INBOUND_REPL
# 然后从其他 DC 重新复制或直接降级重装
```

**③ Lingering Object（残留对象）**：删除后又被旧 DC 复制回来。用 `repadmin /removelingeringobjects` 清理，前提是开启严格复制一致性。

### 站点与桥头堡

跨站点复制走"站点链接"，每个站点选一台**桥头堡服务器（bridgehead）**负责对外。

```powershell
repadmin /bridgeheads /verbose
repadmin /istg                       # 站点间拓扑生成器
repadmin /kcc                        # 强制 KCC 重算拓扑
```

跨站点复制慢，常见原因：

- 站点链接的开销（cost）设得比实际链路差；
- 复制计划设成了"只在夜间"，白天看起来像"不同步"；
- 桥头堡选在了带宽差的机器上；
- 防火墙没放 RPC 动态端口范围。

### 客户端登不进来怎么查

顺序很重要，**先确认 DC 本身健康，再看客户端**。

```powershell
# 1. DC 是否在广告自己
dcdiag /test:advertising /v

# 2. DNS 记录是否齐全（SRV 记录是关键）
nslookup -type=SRV _ldap._tcp.dc._msdcs.corp.local
nslookup -type=SRV _kerberos._tcp.corp.local

# 3. 客户端指向的 DNS 是不是域控
ipconfig /all | findstr "DNS Servers"

# 4. 客户端能不能找到 DC
nltest /dsgetdc:corp.local
nltest /sc_verify:corp.local
```

典型故障对应：

| 现象 | 原因 |
| --- | --- |
| 客户端无法加入域 | DNS 指向了外网 DNS，找不到 SRV 记录 |
| 能加域但登录慢 | 客户端找 DC 超时，通常是因为没配站点 |
| 部分用户登不进 | 该用户所在 DC 复制延迟，账户属性不同步 |
| 提示"信任关系失败" | 机器账户密码不同步，`Test-ComputerSecureChannel -Repair` |
| 登录后组策略不生效 | SYSVOL 复制异常，`dfsrmig /getmigrationstate` 看状态 |

```powershell
# 修复机器账户信任
Test-ComputerSecureChannel -Verbose
Test-ComputerSecureChannel -Repair -Credential (Get-Credential)
```

### DNS 是 AD 的命门

AD 的一切都靠 DNS 的 SRV 记录定位。两条纪律：

1. **域内成员机的 DNS 只能指向域控**，绝不能配外网 DNS（否则找不到域）。
2. 域控自己指向自己（或另一台域控），**不要指向路由器**。

检查：

```powershell
Get-DnsServerZone
Get-DnsServerResourceRecord -ZoneName corp.local -RRType Srv | Measure-Object
dcdiag /test:dns /v /e
```

`dcdiag /test:dns` 会给出 DNS 健康评分，比手工查快。

### SYSVOL 与组策略

```powershell
dfsrmig /getmigrationstate          # 应该是 Eliminated
dfsradmin replication status
```

SYSVOL 不同步会导致"同一策略在不同机器上表现不同"，这是最难查的一类问题。看到 `dfsrmig` 停在 `Prepared` 或 `Redirected` 就说明迁移没完成。

### 一句话总结

AD 排障的顺序是：**DNS → DC 广告 → 复制 → SYSVOL → 客户端**。跳过前四步直接查客户端，90% 会白忙。
