---
title: 供应链安全：从依赖投毒到镜像签名
description: 依赖混淆、typosquatting、构建环境被控、SBOM 与签名验证，以及五个能立刻做的检查。
date: 2025-08-27
tags: [安全, 供应链, 依赖]
---

### 攻击面在哪

```
① 依赖包本身（被投毒/被接管/仿冒）
② 构建环境（CI 被控 → 产物被篡改）
③ 制品分发（镜像仓库/内网源被替换）
④ 更新机制（自动更新链路被劫持）
```

**"我只用知名包"并不能免疫**（大包也可能被接管或投毒）。

### 依赖混淆（Dependency Confusion）

```
攻击者把内部私有包名"抢注"到公共仓库
构建时如果配置了"公网优先"，会拉到攻击者的包
```

**典型例子**：

```
公司内部包：@corp/utils（私有源）
攻击者上传：corp-utils（公共 npm）
如果 npm 配置了多个源且顺序错误 → 拉到了攻击者的
```

**防护**：

```
① 私有源优先，且不允许 fallback 到公网（对内部命名空间）
② 用作用域（@corp/）并锁定 registry
③ 依赖锁定（lock 文件 + 校验和）
```

### typosquatting（仿冒包名）

```
requests  → requestss / reqeusts
lodash    → lodashs
```

**防护**：

```
① 新依赖必须 review（不是"随手 npm i"）
② 用工具检查拼写相似（如 npm 的 package-check）
③ 私有源做白名单（只有审核过的包能进）
```

**"开发随手加了个依赖"是供应链最大的漏洞口**。

### 构建环境被控

```
现象：代码没改，但构建产物里多了"挖矿/后门"逻辑
根源：CI runner 被入侵，或构建脚本被注入
```

**防护**：

```
① CI 用"一次性 runner"（每次全新环境）
② 构建凭据最小权限（只读仓库 + 推镜像）
③ 构建脚本也走 review（不要让 PR 随意改 CI 配置）
④ 产物签名（构建后才能验证来源）
```

**"PR 能改 CI 配置"是严重的权限设计问题**：

```
攻击者提一个 PR 改 workflow → 拿到 secrets
→ 必须限制"来自 fork 的 PR 不能读 secrets"
```

### 依赖锁定与校验

```bash
# Node
npm ci                 # 严格按 lock 文件
npm audit signatures   # 校验签名（npm 支持）

# Python
pip install --require-hashes -r requirements.txt

# Go
go mod verify
```

**"锁定 + 校验和"能挡住"同一版本号内容被替换"**。

### SBOM（软件物料清单）

```bash
# 生成
syft dir:. -o spdx-json > sbom.json
# 或用 trivy
trivy fs --format spdx-json -o sbom.json .
```

**用途**：

```
① 漏洞爆发时"3 分钟定位哪些镜像受影响"
② 合规审计（知道用了什么）
③ 许可证管理
```

**"没有 SBOM 的团队，每次 CVE 都要人工排查一整天"**。

### 镜像签名与验证

```bash
# 用 cosign 签名
cosign sign --key cosign.key registry/app:sha-abc123

# 验证
cosign verify --key cosign.pub registry/app:sha-abc123
```

**更彻底的**：

```
① 用 OIDC 的 keyless 签名（绑定 CI 身份）
② 在部署前强制验证签名（K8s admission controller / Kyverno）
③ 只允许"来自本仓库 CI"的镜像部署
```

**"只验签不强制"等于没做**。

### 五个能立刻做的检查

**① 看依赖数量**

```bash
# Node
npm ls --depth=0 | wc -l
# 传递依赖
npm ls --all | wc -l
```

**"直接依赖 30 个，传递依赖 800 个"** 是常态，也是攻击面。

**② 扫漏洞**

```bash
trivy fs .
trivy image registry/app:latest
```

**③ 查"来源不明的依赖"**

```
① 下载量极低（< 100/周）却被引入
② 最近换了维护者
③ 发布时间与使用时间极近
```

**④ 检查 lock 文件是否被随意改动**

```
"只加了一个功能，为什么 lock 变了几百行？"
→ PR review 时看 lock 的 diff
```

**⑤ 检查 CI 权限**

```
① 是否有 write 权限到主仓库（不该有）
② secrets 是否对所有 workflow 可见
③ fork PR 是否能触发带 secrets 的 workflow
```

### 一个"分级防护"思路

```
第一层（低成本）：锁定 + 校验 + trivy 扫描 + CI 权限收紧
第二层：SBOM + 私有源白名单 + 依赖 review
第三层：镜像签名 + 部署强制验签 + 可复现构建
```

**先把第一层做全，收益最大**。

### 检查清单

```
□ 依赖锁定（lock 文件）并在 CI 用严格模式
□ 有校验和（--require-hashes / npm ci）
□ 私有源优先且禁止 fallback
□ 新依赖走 review
□ CI runner 一次性 + 最小权限
□ fork PR 不能读 secrets
□ 构建脚本变更要 review
□ 有 SBOM（trivy/syft）
□ 镜像签名（cosign）并在部署时强制验签
□ 定期扫漏洞（进 CI）
□ 关注"低下载量/新维护者"的依赖
```
