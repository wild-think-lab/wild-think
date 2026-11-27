---
title: 准入策略：用 Kyverno 把"规范"变成"强制"
description: Kyverno 与 OPA 的分工、四条最该上线的策略、以及五个让策略"上线就崩"的坑。
date: 2026-04-28
tags: [Kubernetes, 安全, 策略]
---

### 为什么需要准入策略

```
口头规范：没人遵守
CI 检查：绕过 CI 直接 kubectl apply → 无效
准入策略：在 API Server 层面拦截 → 强制生效
```

**"只有准入层才能拦住所有写入路径"**。

### Kyverno vs OPA/Gatekeeper

| 维度 | Kyverno | OPA/Gatekeeper |
| --- | --- | --- |
| 配置方式 | YAML 原生（K8s 资源） | Rego 语言 |
| 学习成本 | 低 | 高 |
| 表达能力 | 足够大多数场景 | 更强（复杂逻辑） |
| 变更/mutate | 原生支持 | 需要额外处理 |
| 生成资源 | 支持（generate） | 不支持 |

**"规范类（禁止 latest、必须有 limits）"用 Kyverno 就够**。
**"复杂合规推理"考虑 OPA**。

### 四条最该先上线的策略

**① 禁止 latest 镜像标签**

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-latest-tag
spec:
  validationFailureAction: Enforce
  rules:
  - name: require-image-tag
    match:
      any:
      - resources:
          kinds: [Pod]
    validate:
      message: "不允许使用 latest 标签，请指定明确版本"
      pattern:
        spec:
          containers:
          - image: "!*:latest"
```

**"latest"意味着"每次重启可能换版本"**，事故来源之一。

**② 必须设置 resources**

```yaml
  - name: require-resources
    match:
      any:
      - resources:
          kinds: [Pod]
    validate:
      message: "必须设置 resources.limits"
      pattern:
        spec:
          containers:
          - resources:
              limits:
                memory: "?*"
                cpu: "?*"
```

**没有 limits 的 Pod 会打爆节点**。

**③ 禁止特权容器**

```yaml
  - name: disallow-privileged
    match:
      any:
      - resources:
          kinds: [Pod]
    validate:
      message: "不允许 privileged"
      pattern:
        spec:
          =(ephemeralContainers):
          - =(securityContext):
              =(privileged): "false"
          =(initContainers):
          - =(securityContext):
              =(privileged): "false"
          containers:
          - =(securityContext):
              =(privileged): "false"
```

**④ 强制标签（团队/成本归属）**

```yaml
  - name: require-team-label
    match:
      any:
      - resources:
          kinds: [Deployment]
    validate:
      message: "必须设置 team 标签"
      pattern:
        metadata:
          labels:
            team: "?*"
```

**"标签缺失"会让成本分摊与归属治理全部失效**。

### 渐进上线（最重要的一条）

```
第一步：Audit（只记录不拦截）
第二步：观察一周，看"会拦哪些现有资源"
第三步：修存量 → 切换 Enforce
```

**"直接 Enforce"在生产上大概率会拦住现有工作负载**，导致大面积异常。

```yaml
spec:
  validationFailureAction: Audit
```

**上线前必须"对着现有资源跑一遍"**。

### 五个让策略"上线就崩"的坑

**① 没排除系统命名空间**

```
kube-system 里的组件往往不满足策略
→ 必须 exclude
```

```yaml
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
          - kyverno
```

**② 策略拦住了"控制器自己创建的资源"**

```
Deployment 创建 ReplicaSet/Pod 时会被再校验一次
→ 报错信息看起来"莫名其妙"
```

**③ 策略过于严格导致"临时排障也做不了"**

```
连 debug 用的 Pod 都创建不了
→ 需要"例外机制"（特定标签/命名空间放行）
```

**④ 忘了 Kyverno 自身的高可用**

```
Kyverno 挂了 + failurePolicy=Fail → 整个集群无法创建资源
```

**建议**：

```
非关键策略：failurePolicy=Ignore
关键策略：Fail，但 Kyverno 要多副本
```

**⑤ 策略数量爆炸**

```
50 条策略 → 每次 API 调用都走一遍 → 延迟上升
```

**按"风险"排序，只上真正重要的**。

### 一个"预算"参考

```
策略执行开销 ≈ 每条 1–3ms（复杂策略更高）
→ 20 条以内通常无感
→ 超过 50 条要评估 API 延迟
```

### generate 的用法

```yaml
  - name: default-network-policy
    match:
      any:
      - resources:
          kinds: [Namespace]
    generate:
      kind: NetworkPolicy
      name: default-deny
      namespace: "{{request.object.metadata.name}}"
      data:
        spec:
          podSelector: {}
          policyTypes: [Ingress, Egress]
```

**"新命名空间自动带上默认拒绝策略"** —— 这类"自动补规范"很有价值。

### 检查清单

```
□ 先 Audit 再 Enforce
□ 排除 kube-system / kyverno 命名空间
□ 核心四条：禁 latest、必需 limits、禁 privileged、必需标签
□ 有例外机制（特定标签放行）
□ Kyverno 多副本 + failurePolicy 评估
□ 策略数量控制在可接受范围
□ 策略有版本管理（Git）
□ 变更策略走评审
□ 有"策略拦截量"指标（看是否误拦）
□ 定期回顾策略（清理过期规则）
```
