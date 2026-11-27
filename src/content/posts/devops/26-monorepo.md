---
title: Monorepo 还是多仓库：一次选型的取舍
description: 两种模式的成本对比、工具链（Nx/Bazel/pnpm workspace/Turborepo）、迁移路径与五个"用了 monorepo 更慢"的原因。
date: 2026-08-22
tags: [工程, 协作, 构建]
---

### 先看两边的成本

```
Monorepo（一个仓库存所有项目）
+ 依赖统一、跨项目改动一次提交
+ 版本与契约天然一致
- 构建变慢、权限难控、CI 更复杂

Polyrepo（每个项目一个仓库）
+ 边界清晰、权限简单、构建快
- 跨项目改动要开多个 PR、版本漂移
```

**"选哪个"取决于跨项目改动的频率**，不是取决于潮流。

### 判断标准

```
① 跨项目改动频率（高 → monorepo）
② 团队规模与自治需求（大团队多个小组 → polyrepo 更省事）
③ 技术栈是否统一（多语言 → monorepo 收益下降）
④ 发布是否独立（独立发布多 → monorepo 需要更强工具）
```

### 工具链

```
JS/TS：pnpm workspace + Turborepo / Nx
多语言：Bazel（强，但学习成本高）
Go：Go workspace（go.work）
Python：Pants / uv workspace
```

**"pnpm workspace 只解决依赖，不解决任务编排"** → 还要 Turborepo/Nx。

### 关键能力：只构建"受影响的部分"

```json
// Turborepo: turbo.json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"], "outputs": [] }
  }
}
```

```bash
turbo run build --filter=...[HEAD^]   # 只跑受影响的包
```

**"每次都全量构建"** 是 monorepo 变慢的头号原因。

### 五个"用了 monorepo 更慢"

**① CI 全量跑**

```
没有 affected 检测 → 每次都是 40 分钟
```

**② 依赖没锁定**

```
一个包升级拖着所有包重装
```

**③ 缓存没做**

```
构建缓存（本地 + 远端）没开
```

**④ 仓库太大**

```
git clone 慢（用 partial clone / sparse checkout）
```

```bash
git clone --filter=blob:none <repo>
```

**⑤ 权限没规划**

```
所有人能改所有代码 → 评审形同虚设
→ 用 CODEOWNERS 划分责任
```

### 迁移路径（从 polyrepo 到 monorepo）

```
① 先统一 CI 模板（不强求合并）
② 选一个"跨项目改动最多"的组合并进来
③ 引入任务编排 + 远端缓存
④ 观察 1 个月（构建时长/等待时长）
⑤ 再决定是否扩大
```

**"一次性全并"** 风险最高（CI 会先崩）。

### 反向迁移（monorepo 拆分）

```
① 找出"几乎不跨项目改动"的模块
② 拆出去（保留发布流水线兼容）
③ 用"包管理器/私有仓库"做依赖（而不是源码引用）
```

### 版本与契约

```
monorepo 里最容易被忽视的：内部包版本
① 内部包也要有版本号（不要永远 "workspace:*" 到生产）
② 发布时锁定版本
③ 契约变更要"向前兼容"
```

### 检查清单

```
□ 按"跨项目改动频率"选型（不是跟风）
□ 有 affected 检测（只跑受影响的）
□ 有构建缓存（本地 + 远端）
□ 依赖锁定
□ 大仓库用 partial clone
□ CODEOWNERS 划责任
□ 内部包有版本策略
□ CI 分段（lint 快跑、build 慢跑）
□ 迁移分批（先一个组合）
□ 有"构建时长"监控（防劣化）
```
