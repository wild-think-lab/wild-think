---
title: 组策略排障：策略不生效、生效太慢、生效错了对象
description: GPO 的应用顺序（LSDOU）、gpresult 与 rsop 的用法、三种"不生效"的根因、以及刷新间隔与安全过滤的常见误配。
date: 2026-11-27
tags: [Windows, 组策略, GPO, AD]
---

### 应用顺序：LSDOU

```
L  Local（本地策略）
S  Site（站点）
D  Domain（域）
O  OU（组织单位，从外到内逐层，内层覆盖外层）
U  User/Computer 各自的策略
```

冲突时**后应用的覆盖先应用的**。理解这个顺序，才能解释"我在域级设了但没生效"。

例外：**被标记为 Enforced（强制）的 GPO 不会被下层覆盖**。这是很多"设了但没用"的原因——上层有个强制策略压着。

### 三个必用命令

```cmd
gpresult /r                        # 当前用户/计算机应用了哪些 GPO
gpresult /h C:\gp.html             # 生成完整报告（最有价值）
gpupdate /force                    # 强制刷新
gpupdate /force /target:computer   # 只刷计算机策略
```

`gpresult /h` 的报告里有关键两节：

- **Applied GPOs**：真正生效的列表。
- **Denied GPOs**：被拒绝的（含原因：安全过滤、WMI 过滤、空 GPO）。

**先看 Denied 列表，80% 的问题在那里**。

### 三种"不生效"

**① 安全过滤（Security Filtering）没包含对象**

GPO 默认对"Authenticated Users"生效。如果被改成只对某个组，而目标计算机不在该组里，就完全不生效。

注意：**"读取"权限也要有**。只给"应用组策略"权限而不给"读取"，策略无法下载。

**② WMI 过滤器不匹配**

```sql
SELECT * FROM Win32_OperatingSystem WHERE Version LIKE "10.%"
```

WMI 过滤语法错或条件不满足，GPO 会被静默跳过（在 gpresult 里显示为 denied）。

**③ 目标对象放错 OU**

GPO 链接在某个 OU，但用户/计算机在另一个 OU。AD 是层级结构，**链接不会跨层继承到兄弟 OU**。

排查：

```powershell
Get-ADUser zhangsan -Properties DistinguishedName | Select DistinguishedName
Get-GPO -All | Select DisplayName, GpoStatus
Get-GPLink -Name "策略名"
```

### 生效太慢

刷新间隔（默认）：

| 类型 | 间隔 |
| --- | --- |
| 计算机策略 | 90 分钟（±0–30 分钟随机） |
| 用户策略 | 90 分钟 |
| 域控 | 5 分钟 |

修改后不等 90 分钟：

```cmd
gpupdate /force
```

或者用参数调整（不推荐全局改）：

```
计算机配置 → 管理模板 → 系统 → 组策略
  设置域控制器组策略重新刷新的间隔
```

如果经常需要"立刻生效"，说明策略的变更流程有问题，而不是间隔问题。

### 刷新变慢或卡住

现象：登录要 3 分钟，`gpupdate` 卡在"正在更新策略…"。

三个原因：

1. **SYSVOL 复制延迟**：策略文件在另一台 DC 上还没同步（`dfsrmig`/`repadmin /showrepl` 检查）。
2. **脚本策略里的启动脚本很慢**（同步执行，会拖慢登录）。
3. **DNS 指向错误**：客户端找不到 DC，反复重试。

```cmd
nltest /dsgetdc:corp.local        # 找 DC
dcdiag /test:dns                  # DC 的 DNS 健康
```

### 生效错了对象

现象：某策略影响到了不该影响的部门。

原因排查顺序：

1. **看链接位置**（是不是链在了上层 OU）。
2. **看 Enforced 标记**（强制策略会污染下层）。
3. **看安全过滤**（是不是包含了过大的组）。
4. **用 `gpresult /h` 在"受影响"的机器上跑**，看它到底拿到了哪些策略。

```powershell
# 找出所有链接到某 OU 的 GPO
Get-GPInheritance -Target "OU=dianshang,OU=corp,DC=corp,DC=local"
```

### 常见误配清单

| 误配 | 后果 |
| --- | --- |
| 把"删除"权限给了普通管理员 | 策略被误删 |
| 关闭"计算机配置"但仍期望它生效 | 只留用户配置 |
| 用"块继承"把需要的策略一起挡了 | 上层策略全失效 |
| 启动脚本用 UNC 路径但权限不足 | 脚本静默失败 |
| 策略里配了打印机但驱动没预装 | 登录卡 30 秒 |

`Block Inheritance`（阻止继承）与 `Enforced` 是 AD 里最容易互相"打架"的两个开关。用之前要想清谁该赢。

### 排障流程

```
① 在目标机跑 gpresult /h，看 Applied 与 Denied
② 确认目标对象在哪个 OU（Get-ADUser/Computer）
③ 确认 GPO 链在哪个 OU（Get-GPLink）
④ 检查安全过滤与 WMI 过滤
⑤ 检查是否有 Enforced / Block Inheritance 干扰
⑥ 检查 SYSVOL 复制是否正常
⑦ gpupdate /force 后复测
```

按顺序走，不要"先改策略试试"——那会让问题更难定位。

### 一条纪律

**每次改 GPO 前记录三件事**：改了什么、影响范围（哪些 OU/组）、验证方式（在哪个测试机上看什么）。

GPO 是"一次改动影响几千台机器"的工具，没有记录就没有回滚能力。
