---
title: OSPF 邻居建立不起来的排查清单：从 Down 到 Full 卡在哪一步
description: OSPF 邻居卡在 Init、Exstart、或者是永远 Down，对应的是完全不同的七类原因。按状态定位，比逐个参数撞运气快得多。
date: 2026-11-14
tags: [网络, OSPF, 路由交换, 排障]
---

`display ospf peer` / `show ip ospf neighbor` 里那个状态字段，是 OSPF 排障最重要的线索。先记状态语义，再对照原因。

## 一、状态机与含义

| 状态 | 含义 | 说明 |
| --- | --- | --- |
| Down | 未收到任何 Hello | 链路、接口、ACL、多播问题 |
| Init | 收到 Hello 但对方未把我列进邻居列表 | **单向可见**，典型是单向不通或多播被丢 |
| Exstart | 开始协商主从与初始序列号 | 卡这里 → MTU 不一致 |
| Exchange | 交换 LSDB 摘要 | 很少卡住，卡住多为链路质量 |
| Loading | 请求缺失的 LSA | 大量 LSA 缺失 / 邻居反复重启 |
| Full | 完全同步 | 正常 |

## 二、按状态排原因

### 卡在 Down

1. **接口没跑 OSPF**：`network` 宣告未覆盖该接口地址，或接口处于 `passive`。
2. **物理/二层不通**：`display interface` 看 UP/DOWN、CRC 错包；VLAN 未放行。
3. **ACL 拦了 224.0.0.5 / 224.0.0.6**：OSPF 靠多播，安全组策略常误伤。
4. **Router ID 冲突**：两台设备 RID 相同，会互相认为对方是自己。
5. **区域号不一致**：Hello 包里 area ID 不同直接丢弃。

```bash
# 快速自检（华为/思科命令并列，环境不同自行取用）
display ospf interface Vlanif10        # 看 area、DR/BDR、timer
show ip ospf interface vlan10
display ospf error                     # 错误计数，最有价值
show ip ospf statistics errors
```

`ospf error` 里如果 `hello` 相关计数在涨，说明对方 Hello 到了但被我方拒收——问题在参数不匹配，而不是不通。

### 卡在 Init

单向可见。对方能收到我的 Hello，我的 Hello 到不了对方，或对方丢弃了。

- 检查是否为**单向链路**（光纤一芯断、交换机单向 VLAN 放行）。
- 检查对方接口是否配置了 `ospf authentication` 而我没配（认证失败会表现为收不到有效 Hello）。
- 检查 MTU 与二层封装是否有截断。

验证方式：两侧同时抓包。

```bash
# Linux 侧用 tcpdump 观察双向是否都有 Hello
sudo tcpdump -i eth0 -c 20 'ip proto 89'
```

### 卡在 Exstart

**MTU 不一致**是头号原因。OSPF 在 OSPFv2 中用 MTU 字段协商，一侧 MTU 小就直接不回应（除非配置了 `ignore-mtu`）。

- 检查 `display interface` 的 MTU，隧道/VRF/PPPoE 场景最常见。
- 临时绕过（仅测试用）：`ospf mtu-ignore`，生产环境应统一 MTU。

## 三、参数不一致清单（逐项核对）

| 参数 | 必须一致？ | 不一致现象 |
| --- | --- | --- |
| Area ID | 必须 | Down |
| Hello / Dead 间隔 | 必须 | Down（且每 10s 反复） |
| 认证类型与密钥 | 必须 | Down / Init |
| MTU | OSPFv2 必须 | Exstart |
| 网络类型（broadcast/p2p） | 建议一致 | 邻居关系异常、DR 选举异常 |
| Router ID | 必须唯一 | 反复重置 |
| 区域类型（标准/Stub/OSPFv3 等） | 必须 | Down 或 LSA 异常 |

## 四、DR/BDR 相关的"假故障"

广播型网络上，非 DR 与 DROther 之间只到 `2-Way`，这是**正常状态**，不是故障。判断依据：

- `2-Way` 只在 DROther↔DROther 之间出现；
- DR/BDR 与所有邻居都应是 Full；
- DR 选举结果看 `display ospf peer` 的 DR/BDR 字段与接口优先级。

如果希望点对点链路上不选举，改网络类型：

```
interface GigabitEthernet0/1
 ospf network-type p2p
```

## 五、验证到收敛

1. `display ospf peer brief` 全 Full。
2. `display ospf lsdb` 两侧数据库应一致（同区域内）。
3. `display ip routing-table` 能看到对方宣告的网段，且 `display ospf routing` 里的 cost 符合预期。
4. 断链测试：`shutdown` 对端接口，确认路由在 Dead 计时器（默认 40s）内消失，恢复后在 Hello 周期内重建——这是验证计时器配置是否生效的唯一可靠方式。

> 一句经验：**OSPF 90% 的"建不起来"是 Down/Init 阶段的三件事——多播被 ACL 拦、area 或认证不匹配、单向链路。Exstart 卡死基本可以直接怀疑 MTU。**
