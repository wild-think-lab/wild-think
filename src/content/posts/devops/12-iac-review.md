---
title: IaC 也要 code review：基础设施代码的评审清单
description: 为什么 IaC 的评审与业务代码不同、六类必须看的问题、plan 输出怎么读，以及"改了 Terraform 结果删了生产库"的复盘。
date: 2026-11-27
tags: [IaC, Terraform, 代码评审, DevOps]
---

### 为什么 IaC 评审更严格

```
业务代码出错 → 影响一个功能
IaC 出错 → 可能删掉整个环境、暴露数据、产生巨额账单
```

**IaC 的"运行环境"是真实基础设施**，没有单元测试能覆盖。

### 六类必须看的问题

**① 破坏性操作**

```hcl
# 危险：改了 instance_type 可能触发重建
resource "aws_instance" "app" {
  instance_type = "t3.medium"    # 从 t3.small 改成 medium
  # 云厂商不一定支持原地改，可能 destroy + create
}
```

评审要看：**这次 plan 里有没有 `destroy`**。

```bash
terraform plan -out=tfplan
terraform show -json tfplan | jq '.resource_changes[] | select(.change.actions[]=="delete")'
```

**② 资源被删了却没人注意**

```hcl
# 有人删掉了这一段
# resource "aws_db_instance" "prod" { ... }
```

manifest 里"少了一段"最难看：diff 里只显示删除行，容易被当成"清理"。

**评审规则：删除任何 `resource` 块必须在 PR 描述里说明**。

**③ 状态与后端**

```hcl
terraform {
  backend "s3" {
    bucket = "company-tfstate"
    key    = "prod/network/terraform.tfstate"
    region = "cn-north-1"
  }
}
```

评审要看：

```
- backend 是否指向正确的环境（prod 的 state 不能被 dev 的配置改）
- 是否开了 state 加密与版本控制
- 是否有人本地跑 apply（应该禁止）
```

**④ 敏感值**

```hcl
# 差
variable "db_password" { default = "Passw0rd!" }

# 好
variable "db_password" { sensitive = true }   # 值来自环境变量/密钥管理
```

评审要看：有没有明文密码、密钥、token。

**⑤ 网络暴露**

```hcl
# 危险
ingress {
  from_port   = 22
  to_port     = 22
  cidr_blocks = ["0.0.0.0/0"]
}
```

评审清单：

```
□ 0.0.0.0/0 的入向规则是否必要
□ 数据库端口是否只对内网
□ 安全组是否最小化
```

**⑥ 成本影响**

```hcl
# 一个不小心：从 1 台变成 10 台
count = 10
```

评审要看：实例数量、规格、存储大小有没有异常变化。

### plan 输出怎么读

```bash
terraform plan

# 关键看这几行
# Plan: 3 to add, 1 to change, 1 to destroy.
```

**"to destroy" 是最高优先级的关注点**。任何一个 destroy 都要问"这是预期的吗"。

再细看：

```bash
terraform plan | grep -E '^\s+[-+]|destroy|replace'
```

`replace` 也危险：**"change"看起来无害，但如果是 replace 就等于重建**（会短暂中断，且数据可能丢）。

### 一次"删了生产库"的复盘

**变更内容**：整理模块，把 `aws_db_instance` 从一个模块移到另一个模块。

**发生什么**：

```
terraform apply 时，旧模块的实例被 destroy，新模块创建了新实例
→ 生产数据库被删（虽有快照，但恢复到可用状态花了 4 小时）
```

**根因**：

```
① 移动资源时没有用 `moved` 块（Terraform 会认为是"删除+新建"）
② PR 里 plan 输出没被完整看（只看了 "Plan: 1 to add, 1 to destroy"）
③ 没有人在生产环境做灰度（直接 apply 到 prod）
```

**修复方式（Terraform 0.13+）**：

```hcl
moved {
  from = module.old_db.aws_db_instance.main
  to   = module.new_db.aws_db_instance.main
}
```

有了 `moved`，Terraform 只更新 state 里的地址，不会真的删建。

**改进**：

```
① 生产 apply 必须两人复核 plan
② "to destroy" 必须在 PR 里逐条解释
③ 移动资源一律用 moved 块
④ 生产 apply 走流水线（有审批），不允许本地跑
```

### 评审清单（可直接贴到 PR 模板）

```markdown
## IaC 变更自查
- [ ] plan 里有 destroy 吗？逐条说明原因
- [ ] 有 replace 吗？确认业务能接受中断
- [ ] 是否用了 moved 块（移动/重命名资源）
- [ ] 有明文密码/密钥吗（应改用密钥管理）
- [ ] 有 0.0.0.0/0 的入向规则吗
- [ ] 成本变化是否合理（实例数/规格/存储）
- [ ] backend 指向正确的环境
- [ ] state 是否已备份
```

### 安全实践

```
① state 文件加密 + 访问受限（它含所有资源信息，包括敏感值）
② 禁止本地 apply（统一走 CI，用 OIDC 拿临时权限）
③ 每次 apply 前自动备份 state
④ 环境隔离：dev/staging/prod 用不同的 backend 与不同凭据
⑤ 关键资源加 `prevent_destroy`（防误删）
```

```hcl
lifecycle {
  prevent_destroy = true
}
```

`prevent_destroy` 会让 plan 直接报错，是防止"手滑删库"的最后一道门。

### 检查清单

```
□ PR 模板含 IaC 自查清单
□ plan 输出在 CI 里可见，且有人看
□ destroy/replace 必须解释
□ 移动资源用 moved 块
□ state 加密且访问受限
□ 禁止本地 apply（走 CI + OIDC）
□ 关键资源 prevent_destroy
□ 环境 backend 隔离
□ 每次 apply 前备份 state
```
