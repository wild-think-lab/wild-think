---
title: Terraform 常用命令速查
summary: init/plan/apply 的标准流程、state 操作与坑、import 与 taint、以及"plan 显示要删库"时的止损顺序。
group: 自动化
order: 4
tags: [terraform, IaC, 云]
---

### 标准流程

```bash
terraform init                    # 下载 provider、初始化后端
terraform fmt -recursive          # 格式化
terraform validate                # 语法校验（不查远端）
terraform plan -out=tf.plan       # 生成执行计划（落盘，避免 apply 时再算一遍）
terraform apply tf.plan           # 按计划执行
terraform destroy                 # 销毁（危险）
```

`-out` 落盘的意义：`apply` 用的就是你审过的那个计划，不会因为资源变化而"审的和做的不一样"。

### 环境隔离

```bash
# 用 workspace
terraform workspace new prod
terraform workspace select prod
terraform workspace list

# 或用独立目录（更推荐）
environments/
├─ dev/    main.tf backend.tf
├─ prod/   main.tf backend.tf
```

独立目录的好处：state 天然隔离，不会误在 prod 上 `destroy`。

### State 操作

```bash
terraform state list                       # 列出管理的资源
terraform state show aws_instance.web      # 看某个资源的当前状态
terraform state mv a.b c.d                 # 重命名（重构模块时用）
terraform state rm aws_instance.web        # 从 state 移除（不再管理，但不删除）
terraform state pull > backup.tfstate      # 备份
```

**改 state 前必须备份**。state 损坏的代价是"资源还在但 Terraform 不认"，重建会带来停机。

### import：接管已存在的资源

```bash
# 1.34+ 用 import block（推荐，可写进代码）
```

```hcl
import {
  to = aws_instance.web
  id = "i-0123456789abcdef0"
}
```

```bash
terraform plan -generate-config-out=generated.tf   # 生成对应配置
terraform apply
```

旧方式：

```bash
terraform import aws_instance.web i-0123456789abcdef0
```

`import` 之后要 `plan` 确认"无差异"，否则说明配置与真实资源不一致。

### taint / 替换

```bash
terraform taint aws_instance.web      # 标记为脏，下次 apply 重建
terraform untaint aws_instance.web
# 新版推荐
terraform apply -replace=aws_instance.web
```

### 常见坑与处理

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `plan` 显示要删数据库 | 配置改动导致资源被判定为"替换" | **先看 `-/+` 标记**，为有状态资源加 `lifecycle { prevent_destroy = true }` |
| `state lock` 报错 | 上次异常退出留下锁 | 确认无人操作后 `terraform force-unlock <id>` |
| provider 版本漂移 | 未锁版本 | `.terraform.lock.hcl` 必须提交 |
| 计划与执行不一致 | 没落盘 plan | 用 `-out` |
| 部分资源创建成功但 apply 失败 | 网络/配额 | 修问题后重新 `apply`（Terraform 会续做） |

### 防"删库"三道保险

```hcl
resource "aws_db_instance" "main" {
  # ...
  lifecycle {
    prevent_destroy = true          # 拒绝销毁
    ignore_changes  = [password]    # 忽略手工改动的字段
  }
}
```

1. `prevent_destroy`：销毁时报错，必须人工改代码才能删。
2. `ignore_changes`：避免"外部改了密码 → plan 显示要重建"。
3. **远程 state + 锁**：S3/DynamoDB 或 Terraform Cloud，避免多人同时 apply。

```hcl
terraform {
  backend "s3" {
    bucket         = "tf-state-prod"
    key            = "prod/terraform.tfstate"
    region         = "ap-east-1"
    dynamodb_table = "tf-lock"
    encrypt        = true
  }
}
```

### 排障

```bash
TF_LOG=DEBUG terraform plan 2> tf.log     # 详细日志
terraform providers                       # 看 provider 来源与版本
terraform graph | dot -Tpng > g.png       # 依赖图
```
