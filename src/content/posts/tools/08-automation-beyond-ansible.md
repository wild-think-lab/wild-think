---
title: Ansible 之外的自动化：什么时候该从 playbook 换到"配置管理平台"
description: Ansible 的边界在哪、SaltStack 与 Puppet 的定位、幂等与收敛的区别、以及"该不该上平台"的判断表。
date: 2026-11-27
tags: [自动化, Ansible, SaltStack, 配置管理]
---

### Ansible 的边界

擅长：

- 批量执行一次性的运维动作（装包、改配置、重启服务）。
- 中小规模（<500 台）的配置一致性。
- 临时变更与排障（ad-hoc）。

吃力的地方：

1. **万级节点**：SSH 连接开销大，跑一遍全量要很久。
2. **持续收敛**：Ansible 是"我去执行一次"，不是"系统持续保持某状态"。
3. **实时状态查询**：想知道"现在 500 台机器的某个配置是什么值"，Ansible 得跑一遍才知道。
4. **大规模事件驱动**：需要"某台机器变更后触发另一动作"，靠 Ansible 编排很别扭。

### 三种自动化的定位

| | Ansible | SaltStack | Puppet/Chef |
| --- | --- | --- | --- |
| 通信 | SSH（无 agent） | 常驻 agent + ZeroMQ | 常驻 agent |
| 模式 | 推（push） | 推 + 拉 | 拉（agent 定期收敛） |
| 速度 | 中 | 快（万级可分钟级） | 中 |
| 收敛 | 执行一次 | 可持续（高 state 频率） | 天然持续收敛 |
| 学习曲线 | 低 | 中 | 中高 |

一句话：**Ansible 是"工具"，Salt 是"平台"，Puppet 是"状态机"**。

### 什么时候该换

判断表（满足 2 项以上再考虑）：

```
□ 节点数 > 1000，且需要分钟级全量执行
□ 需要"随时查询全网状态"（而不是跑一遍才知道）
□ 需要持续收敛（配置被改回来自动纠正）
□ 需要事件驱动（变更触发联动）
□ 需要细粒度权限与审计（谁能改哪些机器）
```

如果只满足 1 项，通常优化 Ansible（`forks`、`pipelining`、fact 缓存）就够了。

### Ansible 提速的五个动作

```ini
# ansible.cfg
[defaults]
forks = 100
pipelining = True
gathering = smart
fact_caching = jsonfile
fact_caching_connection = /tmp/ansible_facts
fact_caching_timeout = 3600
```

1. `forks` 提到 50–100（受控端能承受的话）。
2. `pipelining=True` 减少 SSH 往返（要求被控端 `requiretty` 关闭）。
3. fact 缓存，避免每次重复收集。
4. 用 `strategy: free` 替代线性执行。
5. 大任务拆成"按角色分组并行"。

### SaltStack 的核心优势：状态查询与事件

```bash
# 全网查询（秒级返回）
salt '*' cmd.run 'systemctl is-active nginx'
salt '*' grains.get os
salt '*' pkg.version openssl

# 批量执行
salt -N 'web' state.apply nginx

# 事件驱动（beacon + reactor）
salt-run state.event pretty=True
```

"全网秒级查询"是 Salt 最不可替代的能力：Ansible 要查 500 台得跑几分钟，Salt 靠常驻 agent 直接返回。

代价：**每台机器要有 agent 进程**，以及 master 的高可用（master 挂了全网失去控制）。

### 收敛 vs 执行：概念差异

```
执行（Ansible）：我告诉你做什么 → 做完了就结束
收敛（Puppet）：我声明"应该是什么样" → agent 定期检查并纠正
```

收敛的价值：**配置漂移会自动被修回**。有人手工改了 nginx.conf，下一轮 agent 跑完就恢复。

代价：**手工临时改动会被覆盖**，排障时会很崩溃（"我明明改了怎么又变回去了"）。

折中做法：允许"临时变更"走显式流程（暂停 agent 或改代码后重新发布），而不是直接改机器。

### 平台化的四个必要件

不管选哪个，上平台前要有：

1. **CMDB / 资产清单**：机器是谁的、什么角色、在哪个环境。没有它，自动化脚本就是在猜。
2. **密钥管理**：Ansible Vault / Vault / KMS，不要把密码写进 playbook。
3. **变更审计**：谁在什么时候对哪些机器做了什么，要留痕。
4. **回滚能力**：能快速回到上一版配置（Git + 版本化）。

缺任何一项，自动化都会在半年后变成"没人敢跑的脚本"。

### 一个渐进路径

```
阶段 1：Ansible ad-hoc + 少量 playbook（50 台以内）
阶段 2：角色化 + Git 管理 + CI 校验（syntax-check、lint）
阶段 3：Ansible AWX/Tower 或 Semaphore，加权限与审计
阶段 4：节点上千或需要状态查询 → 评估 Salt
阶段 5：需要持续收敛与合规模板 → 评估 Puppet/Chef（或直接用云厂商的合规服务）
```

**不要跳级**：从 50 台直接上 Puppet，通常结果是"没人会用、配置写在模板里没人敢改"。

### 判据总结

- 你要"做一次变更" → Ansible。
- 你要"随时知道全网状态 + 秒级批量执行" → Salt。
- 你要"配置永远保持某状态（合规审计）" → Puppet/Chef。
- 你要"事件触发的联动" → Salt reactor 或消息队列 + 自研控制器。
