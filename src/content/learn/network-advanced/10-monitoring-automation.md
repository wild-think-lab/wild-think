---
title: 网络监控与自动化：把"人工巡检"换成"指标 + 告警"
module: 进阶篇
summary: SNMP 与设备指标、链路与丢包监控、配置备份与自动化改动,以及五个"监控装了但没人看"的原因。
minutes: 45
---

### 该监控什么

```
① 设备可用性（ping/SNMP）
② 端口/链路流量（利用率）
③ 错误与丢包（error/discard）
④ 温度/电源/风扇
⑤ 配置变更（谁改了什么）
⑥ 证书与许可到期
```

### SNMP：老但依然可用

```bash
snmpwalk -v2c -c public 10.0.0.1 1.3.6.1.2.1.2.2.1.10   # 接收字节
snmpwalk -v2c -c public 10.0.0.1 ifOperStatus
```

**用 v3**（v2c 的 community 是明文口令）。

**Prometheus 采集**：

```yaml
- job_name: snmp
  metrics_path: /snmp
  params: {module: [if_mib]}
  static_configs:
  - targets: [10.0.0.1]
  relabel_configs:
  - source_labels: [__address__]
    target_label: __param_target
  - target_label: instance
    replacement: 10.0.0.1
```

### 链路利用率的判据

```
> 70% 持续 → 考虑扩容/分流
error/discard 增长 → 物理层/拥塞
```

**"带宽够但慢"** → 看丢包与重传，不要只看带宽。

### 配置备份（最低成本的高可用）

```bash
# 简单方式：expect/ssh 抓 show running-config 到 git
for h in $(cat hosts); do
  ssh "$h" "show running-config" > "backup/$h-$(date +%F).cfg"
done
git -C backup add -A && git -C backup commit -m "auto backup $(date +%F)"
```

**"改错了没备份"** 是网络事故里最常见的一类。

### 自动化改动（谨慎）

```
① 先"只读"（收集/对比）
② 再"生成配置 + diff"（人审）
③ 再"小范围应用"（一台设备）
④ 最后"批量 + 回滚脚本"
```

**"脚本直接批量改交换机"** 一次错就全网断。

### 五个"监控装了但没人看"

```
① 只监控"设备 ping"，不监控链路质量
② 告警太多（每天几百条）→ 麻木
③ 没有"可行动"提示（只报"端口 down"）
④ 没接值班流程（告警没人认领）
⑤ 没有基线（不知道"正常长什么样"）
```

### 一个"最小可用"的网络监控

```
① 设备 ping（可用性）
② SNMP 流量与错误（关键链路）
③ 配置每日备份进 git
④ 证书/许可到期提醒
⑤ 告警分级（P1 电话，其余 IM）
```

### 检查清单

```
□ 设备与链路可用性监控
□ 流量/错误/丢包指标
□ 硬件健康（温度/电源）
□ 配置备份（含 diff 与历史）
□ 变更记录（谁改了什么）
□ 证书/许可到期告警
□ 告警分级且有人认领
□ 有基线（正常值范围）
□ 自动化先只读、再小范围
□ 有回滚脚本
```
