---
title: SaltStack 还值得学吗：和 Ansible 的真实差别
description: master-minion 架构、state 与 pillar、事件总线与 mine，以及"什么时候该用 Salt 而不是 Ansible"的四个判断。
date: 2026-11-27
tags: [SaltStack, 配置管理, 自动化]
---

### 一句话差别

```
Ansible：无 agent、SSH 推送、按 playbook 顺序执行
Salt：有 agent、消息队列（ZeroMQ）、并行执行 + 事件总线
```

**Ansible 是"远程执行脚本"，Salt 是"分布式执行引擎"**。

### 架构差别带来的四个实际影响

| | Ansible | Salt |
| --- | --- | --- |
| 规模 | 数百台还行，上千台变慢 | 上万台仍可（并行） |
| 速度 | 慢（SSH 串行、fork 进程） | 快（并行、长连接） |
| 依赖 | 仅需 SSH | 需要装 minion（或 ssh 模式） |
| 灵活性 | 极强（任何命令都能跑） | 强（但更"结构化"） |

**Ansible 上千台的真实痛点**：默认 fork 5 个进程，1000 台要跑很久；即使开了 `strategy: free` 与 `forks: 100`，也受 SSH 握手开销限制。

### 核心概念

**① State（相当于 playbook 的"声明"）**

```yaml
# /srv/salt/nginx/init.sls
nginx:
  pkg.installed: []
  service.running:
    - enable: true
    - reload: true
    - watch:
      - file: /etc/nginx/nginx.conf

/etc/nginx/nginx.conf:
  file.managed:
    - source: salt://nginx/nginx.conf
    - user: root
    - group: root
    - mode: 644
```

**语法是"ID + 模块.函数 + 参数"**，比 Ansible 的 YAML 更紧凑。

**② Top file（决定谁执行什么）**

```yaml
# /srv/salt/top.sls
base:
  'roles:web':
    - match: grain
    - nginx
    - app.deploy
  'roles:db':
    - match: grain
    - mysql
```

**③ Grain（minion 自身的属性）**

```bash
# 内置 grain：os、os_family、num_cpus、mem_total、fqdn...
salt '*' grains.items

# 自定义 grain
salt 'web01' grains.setval roles '["web","prod"]'
```

**④ Pillar（保密/差异化数据）**

```yaml
# /srv/pillar/db.sls
db:
  password: "******"
  port: 3306
```

```yaml
# /srv/pillar/top.sls
base:
  'roles:db':
    - db
```

**Pillar 与 Grain 的区别**：

```
Grain：minion 自己的信息（OS、CPU、自定义标签），minion 可改
Pillar：master 下发的数据（密码、配置），minion 只读
```

### 远程执行（Salt 最强的地方）

```bash
salt '*' test.ping                    # 所有 minion
salt 'web*' cmd.run 'uptime'          # 按 glob
salt -G 'os:Ubuntu' pkg.list_upgrades # 按 grain
salt -N webservers cmd.run 'date'     # 按 group
salt -E 'web0[1-9]' test.ping         # 正则
salt --batch 20 '*' cmd.run 'apt-get update'   # 分批（重要）
```

**`--batch` 是生产必须的**：一次推 1000 台等于瞬间打满网络与包源。

**`cmd.run` 与 `cmd.wait` 的区别**：

```
cmd.run    立即执行（不幂等）
cmd.wait   等到 watch 触发才执行
```

### 事件总线（Ansible 没有的能力）

```bash
# 监听事件
salt-run state.event pretty=True
```

minion 上线、任务完成、自定义事件都会发到总线。用途：

```
① 自动注册（minion 上线时自动分配角色）
② 任务编排（A 完成后触发 B，不用写 playbook 顺序）
③ 告警联动（某台机器 state 失败 → 发通知）
```

**这是 Salt 与 Ansible 最本质的差别**：Ansible 是"我推你执行"，Salt 是"事情发生了，谁该响应"。

### Mine（跨 minion 共享数据）

```yaml
# minion 端：声明要共享什么
mine_functions:
  network.ip_addrs:
    - eth0
```

```bash
# master 端：拿到所有机器的 IP
salt '*' mine.get '*' network.ip_addrs
```

用途：**自动生成配置**（如所有 web 节点配置里要列出所有 db 节点 IP）。

**Ansible 里做这事需要 `hostvars` 或动态 inventory**，Salt 的 mine 更自然。

### 什么时候该用 Salt

**① 规模上千台**

```
真实门槛：> 500 台时 Ansible 开始难受，> 2000 台明显
```

**② 需要"秒级"下发**

```
如：紧急下线所有节点的某个服务、全量改一个配置
Ansible 要几分钟，Salt 可以几十秒
```

**③ 需要事件驱动**

```
自愈、自动注册、联动告警
```

**④ 已有 Salt 存量**

```
迁移成本 > 收益时，不要为了"统一用 Ansible"而迁
```

### 什么时候 Ansible 更合适

```
① 规模 < 300 台
② 不允许装 agent（合规/客户环境）
③ 团队已熟练 Ansible
④ 临时/一次性任务多（Ansible 的 ad-hoc 更顺手）
```

**"没 agent"是很现实的理由**：很多客户环境只给你 SSH。

### 一次典型的 Salt 落地

```
① 装 salt-master（1–2 台，做 HA 用多 master）
② 装 salt-minion（批量脚本/bootstrapping）
③ 接受密钥：salt-key -L / -A
④ 写 grain 标记角色：salt '*' grains.setval roles '["base"]'
⑤ 写 top.sls 按 role 分发
⑥ 分批首次执行：salt --batch 20 '*' state.apply
⑦ 接入 Git（state 文件在 Git 里，CI 校验语法）
```

**`salt-key` 的坑**：默认自动接受关闭，新 minion 要手动 accept；大批量时用 `salt-key -A -y`。

### State 幂等性的坑

```yaml
# 差：每次都执行
run-script:
  cmd.run:
    - name: /opt/deploy.sh

# 好：只在文件变化时执行
run-script:
  cmd.wait:
    - name: /opt/deploy.sh
    - watch:
      - file: /opt/app.tar.gz
```

**`cmd.run` 不幂等**，会导致每次 `state.apply` 都执行一遍（高 state 变成"每次都重启服务"）。

### 检查清单

```
□ master 有备份或 HA（多 master）
□ 密钥接受流程明确（不盲目 -A）
□ grain 定义角色规范
□ pillar 里放密码，不放 state
□ 大批量执行用 --batch
□ state 用 cmd.wait 而不是 cmd.run（含 watch）
□ state 文件在 Git + CI 校验
□ 有事件总线监控（state 失败告警）
□ 规模超 500 台时认真评估 Salt
```
