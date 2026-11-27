---
title: Terraform 实战：把基础设施写成能 review 的代码
description: state 管理、模块划分、provider 与 workspace、plan/apply 的规矩，以及五个"一上生产就出事"的习惯。
date: 2024-09-18
tags: [Terraform, IaC, DevOps]
---

### 三分钟理解它的模型

```
Provider ：对接云厂商 API（aws/google/alibaba）
Resource ：一个资源（一台机器、一个 VPC）
Module   ：一组资源的封装
State    ：记录"我已经创建了什么"（关键！）
```

**Terraform 的核心不是"写 YAML"，而是"管理 state 与真实资源的对应关系"**。

### state 是最重要的东西

```bash
terraform state list            # 看有哪些资源
terraform state show aws_instance.web
```

**为什么 state 关键**：

```
Terraform 靠 state 判断"要不要创建/更新/删除"
state 丢了 → 它以为资源不存在 → 会重新创建（可能冲突）
state 与真实不一致 → plan 结果不可信
```

**所以**：

```
① state 必须远程存储（不能只在本地 terraform.tfstate）
② state 必须加锁（防并发 apply）
③ state 必须备份
```

**S3 后端**：

```hcl
terraform {
  backend "s3" {
    bucket         = "my-tf-state"
    key            = "prod/network/terraform.tfstate"
    region         = "ap-northeast-1"
    dynamodb_table = "tf-locks"      # 加锁
    encrypt        = true
  }
}
```

**`dynamodb_table` 是防"两个人同时 apply"的关键**。

### 模块划分

**推荐三层**：

```
modules/           # 可复用的模块（无环境信息）
  network/
  k8s-cluster/
  rds/

envs/              # 每个环境一份
  dev/
    main.tf        # 调用 modules
    terraform.tfvars
  prod/
    main.tf
```

**模块的接口要窄**：

```hcl
# modules/network/variables.tf
variable "vpc_cidr" { type = string }
variable "env"      { type = string }
variable "az_count" {
  type    = number
  default = 3
}

# outputs.tf
output "vpc_id"    { value = aws_vpc.main.id }
output "subnet_ids" { value = aws_subnet.private[*].id }
```

**"接口窄"的意义**：模块内可以随意重构，只要 outputs 不变。

### 五个"一上生产就出事"的习惯

**① 用 `-auto-approve` 不看 plan**

```bash
terraform plan -out=tfplan
terraform apply tfplan        # 应用"你看过的那一份"
```

**`-out` 的意义**：

```
plan 与 apply 之间资源可能变化
用同一个 plan 文件 → 保证"执行的就是审查过的那份"
```

**永远不要 `apply -auto-approve` 到生产**。

**② 一个 workspace 管所有环境**

```
错的：terraform workspace select prod（同一个 state 目录）
```

**原因**：

```
workspace 共享同一份配置，只是 state 分开
权限、变量、provider 都容易混
```

**推荐：每个环境独立目录**（`envs/dev`、`envs/prod`），各自有 backend 配置。

**③ 手工改了控制台，Terraform 不知道**

```
现象：控制台加了个安全组规则 → plan 显示要删掉它
原因：Terraform 只认代码
后果：下次 apply 覆盖人工改动（有时是好事，有时是灾难）
```

**处理**：

```
① 统一用代码（改控制台是技术债）
② 临时改动要同步到代码
③ 用 plan 定期巡检"漂移"
```

**④ 用 `count` 而不是 `for_each`**

```hcl
# 差：删中间一个，后面全部重新编号 → 重建资源
resource "aws_instance" "web" {
  count = 3
  ...
}

# 好：按 key 索引，删哪个只删哪个
resource "aws_instance" "web" {
  for_each = toset(["a","b","c"])
  ...
}
```

**`count` 的"序号漂移"是经典事故**。

**⑤ 敏感信息写进代码**

```hcl
# 错
variable "db_password" { default = "P@ssw0rd" }
```

**正确**：

```
① 用环境变量：TF_VAR_db_password
② 或从 Vault / SSM 拉
③ 敏感输出加 sensitive = true
```

```hcl
output "db_endpoint" {
  value     = aws_db_instance.main.endpoint
  sensitive = true
}
```

### plan 输出怎么读

```
+ 创建
- 删除
~ 修改（原地）
-/+ 替换（先删后建）
<=> 替换（先建后删，需 create_before_destroy）
```

**最危险的是 `-/+`（replace）**：

```
意味着"删掉重建" → 数据可能丢、IP 可能变
生产环境必须逐个确认
```

**"意外 replace"的常见原因**：

```
① 改了不可变属性（如 instance type 在旧版、AMI 变了）
② 改了 name 或 tag（有些资源改名=重建）
③ provider 版本升级改变了默认行为
```

### 版本锁定

```hcl
terraform {
  required_version = ">= 1.5, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
```

**必须提交 `.terraform.lock.hcl`**：

```
锁定 provider 的具体版本与校验和
→ 不同机器/CI 上行为一致
```

**不锁的后果**：CI 上装到新版本 → 默认行为变了 → plan 突然出现大量 replace。

### CI 中的正确姿势

```bash
# PR 阶段
terraform fmt -check -recursive
terraform validate
terraform plan -out=tfplan
# 把 plan 输出贴到 PR 评论（需要工具如 atlantis）

# 合并后
terraform apply tfplan
```

**关键点**：

```
① PR 只跑 plan（不 apply）
② plan 结果要给人看（而不是"CI 绿了就合"）
③ apply 用同一个 plan 文件
④ 有"infracost"估算成本更好
```

**Atlantis / GitHub Actions + terraform 是最常见的落地方式**。

### 一个"安全"的 apply 流程

```bash
# 1. 确认在正确目录
pwd && terraform workspace show

# 2. 拉最新代码
git pull

# 3. plan（保存）
terraform plan -out=tfplan -var-file=prod.tfvars

# 4. 检查 plan（重点看 replace 与 delete）
grep -E "^\s+(-/+|-) " tfplan.txt

# 5. 有 replace → 停下来评估数据影响

# 6. apply
terraform apply tfplan
```

**第 4 步是最有价值的一步**，能拦住 80% 的意外。

### 检查清单

```
□ state 远程存储 + 加密 + 加锁
□ 每个环境独立目录（不共用 workspace）
□ 模块接口窄（variables/outputs 稳定）
□ PR 只 plan，合并后 apply
□ 用 -out 保存 plan，apply 同一份
□ 生产不用 -auto-approve
□ 用 for_each 而非 count
□ 敏感值走环境变量/密钥管理
□ 锁 provider 版本 + 提交 lock 文件
□ 定期巡检漂移（plan 与真实对比）
□ plan 里逐个确认 replace
```
