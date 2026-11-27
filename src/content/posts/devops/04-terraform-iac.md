---
title: Terraform 与 IaC：从"手点控制台"到可复现的基础设施
description: state 到底是什么、plan/apply 的流程与安全边界、目录与模块怎么拆、remote backend 与锁、和 Ansible 的分工，以及几个真实踩过的坑。
date: 2022-07-14
tags: [Terraform, IaC, 云原生, DevOps, 自动化]
---

### 为什么不能继续手点控制台

手点控制台的问题不是"慢"，而是**不可复现**：没人记得半年前那台机器加了哪个安全组、改过哪条路由。出故障时靠回忆，扩容时靠照抄，审计时靠截图。

IaC 的本质是把"基础设施的期望状态"写成代码，然后由工具去**收敛**到那个状态。

### state 是 Terraform 的心脏

`terraform.tfstate` 记录的是"我创建的资源和云上真实资源之间的对应关系"，里面有资源 ID、属性、依赖关系。

三条铁律：

1. **state 不能进 Git**（里面有敏感信息，且多人并行会冲突）。
2. **state 不能丢**（丢了工具就以为资源不存在，会重新创建一遍）。
3. **state 不能多人同时写**（要靠锁）。

丢了 state 的补救：

```bash
terraform import aws_instance.web i-0abc123def456
# 或者从备份恢复，再 terraform refresh 校准
```

### 一次标准的改动流程

```bash
terraform init          # 下载 provider，初始化 backend
terraform fmt -recursive
terraform validate
terraform plan -out=tfplan       # 一定要落盘，apply 时用同一个 plan
terraform apply tfplan
```

`plan` 的输出要当成"变更评审单"来看：`+ create`、`- destroy`、`~ update in-place`、`-/+ replace`。

**看到 `-/+` 要停一下**。in-place 更新和替换是两回事：改一个 `user_data` 可能触发整台机器重建，生产上就是一次事故。想避免，就给关键参数加：

```hcl
lifecycle {
  create_before_destroy = true
  prevent_destroy       = true    # 保护数据库等关键资源
  ignore_changes        = [tags, user_data]
}
```

### 目录与模块怎么拆

小团队别上"大一统"。一个可维护的结构：

```
infra/
├── modules/
│   ├── network/          # vpc、子网、安全组
│   ├── compute/          # 实例、镜像、启动脚本
│   └── k8s-cluster/
├── envs/
│   ├── dev/  main.tf  backend.tf  terraform.tfvars
│   ├── staging/
│   └── prod/
└── versions.tf
```

原则：

- **modules 里不写具体值**，全用变量；`envs/*` 里只放"这个环境不同的部分"。
- 每个 env 独立 state，独立后端目录，互不影响。
- provider 版本必须锁定（`required_version` + `provider` 的 `version`），否则半年后 `init` 会给你一个惊喜。

### remote backend 与锁

S3 后端（最常见的组合）：

```hcl
terraform {
  backend "s3" {
    bucket         = "acme-tfstate"
    key            = "prod/network/terraform.tfstate"
    region         = "ap-northeast-1"
    encrypt        = true
    dynamodb_table = "acme-tfstate-lock"   # 加锁，防并发 apply
  }
}
```

不加锁的后果：两个人同时 apply，后一个会把前一个的改动覆盖成"不存在的资源"，然后引发一连串删了又建。

### 和 Ansible 的分工

一句话：**Terraform 管"机器存在不存在"，Ansible 管"机器里面长什么样"**。

| | Terraform | Ansible |
| --- | --- | --- |
| 对象 | 云资源、网络、DNS、IAM | 包、服务、配置文件、用户 |
| 幂等 | 靠 state 比对 | 靠模块自身的幂等 |
| 变更粒度 | 资源级（可能重建） | 任务级（原地改） |
| 典型用法 | `apply` 建好机器 | `playbook` 初始化机器 |

也有人用 Terraform 的 `user_data` 跑 cloud-init 代替 Ansible 首次配置，这是合理的：一次性动作交给 cloud-init，持续收敛交给 Ansible。

### 五个真实踩过的坑

**1. count 与 for_each 的删除顺序。** 用 `count` 建 3 台机器，删掉中间那台，后面两台的索引会变，Terraform 会认为"第 2 台改了配置"而不是"删了一台"。改用 `for_each` + map：

```hcl
resource "aws_instance" "web" {
  for_each = toset(["a", "b", "c"])
  ami      = var.ami
  instance_type = "t3.small"
  tags = { Name = "web-${each.key}" }
}
```

**2. 循环依赖。** A 引用 B 的输出，B 又引用 A 的变量，plan 直接报 cycle。拆一个中间层，或把可变部分挪到变量。

**3. 敏感值写进 tfvars 并提交。** state 和 tfvars 都可能泄露密钥。用环境变量 + provider 的默认读取，或者接 Vault/SSM。

**4. provider 升级导致属性改名。** 老版本 `aws_instance.ebs_optimized` 之类字段在新 provider 里语义变了，`validate` 能过但 plan 会给出意外 diff。锁版本，升级单独一个 PR。

**5. destroy 之前不 plan。** `terraform destroy` 会删掉 state 里的**所有**资源，包括你以为"不在这个目录"的东西。永远先 `plan -destroy` 看清单。

### CI 里怎么跑

```yaml
# 伪代码：PR 阶段只 plan，merge 后 main 分支才 apply
- run: terraform init
- run: terraform plan -out=tfplan -no-color
- run: terraform show -json tfplan > plan.json   # 存档，便于审计与自动检查
- if: branch == main
  run: terraform apply -auto-approve tfplan
```

PR 阶段把 plan 输出贴到评论里，评审就看这个 diff。别让"随手 apply"变成个人习惯。

### 一句话总结

Terraform 的价值不在"能建资源"，而在**plan 那一屏 diff**——它把基础设施变更变成了可评审的代码改动。
