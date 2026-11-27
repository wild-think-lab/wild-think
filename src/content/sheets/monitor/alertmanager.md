---
title: Alertmanager 速查
summary: 路由树、分组抑制静默、告警模板与高可用，以及"告警太多"的治理配置。
group: monitor
order: 3
tags: [Alertmanager, Prometheus, 告警]
---

### 一条告警的完整路径

```
Prometheus rule 触发 → alertmanager → route 匹配 → group → silence/inhibit → receiver
```

**理解这条路径，才能知道"为什么没收到"**。

### 基础配置

```yaml
global:
  resolve_timeout: 5m
  smtp_smarthost: 'smtp.example.com:587'
  smtp_from: 'alerts@example.com'
  smtp_auth_username: 'alerts@example.com'
  smtp_auth_password: 'xxx'

route:
  receiver: 'default'
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
- name: 'default'
  email_configs:
  - to: 'oncall@example.com'
```

**三个 interval 的区别**：

```
group_wait     ：新告警等多久再发（攒一批）
group_interval ：同一组内新告警并入后，多久再发
repeat_interval：持续未恢复，多久重复提醒
```

**调错的表现**：

```
group_wait 太短 → 告警风暴（一条一发）
repeat_interval 太短 → 骚扰
repeat_interval 太长 → 真出事没人管
```

### 路由树

```yaml
route:
  receiver: default
  routes:
  - matchers: ['severity="critical"']
    receiver: pager
    group_wait: 10s
    repeat_interval: 1h
    routes:
    - matchers: ['service="payment"']
      receiver: payment-team
  - matchers: ['severity=~"info|warning"']
    receiver: slack-low
```

**规则**：

```
① matchers 用 = / != / =~ / !~
② 从根往下匹配，第一个匹配的 route 生效（除非 continue: true）
③ 默认 stop，写了 continue: true 会继续匹配兄弟节点
```

**`continue: true` 的用途**：一条告警要同时发多个渠道。

### 静默（Silence）

```bash
# 用 amtool（推荐）
amtool silence add alertname="HighCPU" --duration=2h --comment="known issue"
amtool silence query
amtool silence expire <id>
```

**UI 也可以创建**（访问 `/silences`）。

**静默 vs 抑制的区别**：

```
静默：人为临时屏蔽（维护窗口）
抑制：规则自动屏蔽（告警之间的依赖关系）
```

### 抑制（inhibit_rules）

```yaml
inhibit_rules:
- source_matchers: ['alertname="NodeDown"']
  target_matchers: ['alertname=~"HighCPU|HighMemory|DiskFull"']
  equal: ['instance']
```

**含义**：同主机有 NodeDown 时，抑制它的 CPU/内存/磁盘告警。

**这是治理告警风暴最有效的配置**。

**常用抑制对**：

```
NodeDown        → 抑制该节点所有资源告警
ServiceDown     → 抑制该服务的延迟/错误率告警
ClusterDown     → 抑制该集群所有告警
```

**`equal` 是"必须相等才抑制"的标签列表**，写错就抑制不了。

### 分组（group_by）

```yaml
group_by: ['alertname', 'cluster', 'service']
```

**分组原则**：

```
同一"根因"的告警应在一组：
  按 instance 分组 → 一个节点的问题一起发
  按 service 分组 → 一个服务的问题一起发
不要按 instance + alertname 分 → 会导致大量小分组
```

### 告警模板

```yaml
receivers:
- name: slack
  slack_configs:
  - api_url: 'https://hooks.slack.com/...'
    channel: '#alerts'
    title: '{{ .Status | toUpper }} {{ .CommonLabels.alertname }}'
    text: |
      {{ range .Alerts }}
      *{{ .Annotations.summary }}*
      {{ .Annotations.description }}
      实例: {{ .Labels.instance }}
      {{ end }}
```

**常用变量**：

```
.Status / .CommonLabels / .CommonAnnotations / .Alerts
.ExternalURL（回到 alertmanager 的链接）
```

**邮件模板**：

```yaml
email_configs:
- to: 'oncall@example.com'
  send_resolved: true
  html: |
    <h2>{{ .Status }}: {{ .CommonLabels.alertname }}</h2>
    <p>{{ .CommonAnnotations.description }}</p>
    {{ range .Alerts }}<p>{{ .Labels.instance }}</p>{{ end }}
```

### 发送失败排查

```bash
# 1. 看 alertmanager 日志
journalctl -u alertmanager -n 100

# 2. 看通知失败计数
curl -s localhost:9093/api/v2/status | jq '.data'
# 关注 "notifications":{"failed":N}

# 3. 测试接收器
amtool alert add alertname=Test severity=critical --annotation=description=test
```

**常见原因**：

```
① SMTP 认证失败（密码/端口/STARTTLS）
② Slack webhook 失效
③ 网络不通（出口被限制）
④ 模板渲染报错（字段不存在）
```

### 高可用（集群模式）

```bash
alertmanager \
  --cluster.listen-address=0.0.0.0:9094 \
  --cluster.peer=am2:9094 \
  --cluster.peer=am3:9094
```

**集群解决的问题**：

```
① 静默与通知状态同步（避免双发）
② 一个实例挂了，另一个接管
```

**注意**：

```
Prometheus 要把两个 alertmanager 都配上
alerting:
  alertmanagers:
  - static_configs:
    - targets: ['am1:9093','am2:9093']
```

### 告警治理实操

**第一步：统计告警量**

```bash
# 按 alertname 统计 Top10
curl -s localhost:9093/api/v2/alerts | jq -r '.[].labels.alertname' | sort | uniq -c | sort -rn | head
```

**第二步：分类处理**

```
① "噪音"（不该发的）→ 删除规则或调阈值
② "重复"（同一根因多条）→ 加 inhibit_rules
③ "无行动"（收到也不知道做什么）→ 要么加 runbook，要么删
④ "确有必要"→ 保留并优化通知内容
```

**第三步：设"告警预算"**

```
每人每天 < 10 条 → 团队 5 人 → 每天 < 50 条
超过 = 告警没用（人会开始忽略）
```

**"告警疲劳"是比"漏告警"更常见的问题**。

### 检查清单

```
□ group_wait/group_interval/repeat_interval 合理
□ group_by 按"根因维度"
□ 有 inhibit_rules（NodeDown → 抑制资源告警）
□ critical 走 pager（走电话/短信）
□ warning/info 走低噪渠道（Slack/邮件）
□ send_resolved: true
□ 模板中的字段都真实存在
□ 有 amtool 做静默（维护窗口用）
□ 有集群模式（避免单点）
□ 定期统计告警量并治理
□ 每条告警有 runbook 链接
```
