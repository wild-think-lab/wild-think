---
title: 分支策略：GitFlow 为什么在很多团队"玩不动"
description: 三种策略的适用条件、trunk-based 的前提、发布分支与热修，以及五个"分支越管越乱"的原因。
date: 2026-11-27
tags: [DevOps, Git, 协作]
---

### 三种主流策略

| 策略 | 分支 | 适合 |
| --- | --- | --- |
| GitFlow | main/develop/feature/release/hotfix | 有版本发布节奏、多渠道（App） |
| Trunk-Based | main + 短命分支 | 持续交付、Web/SaaS |
| GitHub Flow | main + feature + PR | 中小团队、简单 |

**"分支模型是团队协作方式的投影"**，不是越复杂越专业。

### GitFlow 的三个成本

```
① 两条长期分支（main/develop）→ 合并冲突常态化
② release 分支存在期间 → 两处修 bug（release 与 develop）
③ hotfix 要同时合并回 main 与 develop（容易漏）
```

**"release 上修了但 develop 没修"** → 下个版本 bug 复现（经典事故）。

### Trunk-Based 的前提

```
① 有自动化测试（否则主干不能随时发布）
② 有功能开关（未完成的功能不上线）
③ 有快速回滚能力
④ 分支存活 < 1–2 天
```

**"没有 CI 强行 trunk-based"** → 主干长期不可发布。

### 一个"务实"的组合

```
main（随时可发布）
├── feature/xxx（短命，PR 合入）
├── release/1.4（发布窗口期保留）
└── hotfix/1.4.1（从 release 拉，修完合回 main 与 release）
```

**"feature 分支不超过 2 天"** 是减少冲突最有效的手段。

### 发布与热修

```bash
# 从 release 拉热修
git switch -c hotfix/1.4.1 release/1.4
# 修完
git commit -am "fix: null check"
git switch release/1.4 && git merge --no-ff hotfix/1.4.1
git tag -a v1.4.1 -m "hotfix 1.4.1"
git push --follow-tags
# 别忘了合回 main
git switch main && git merge --no-ff hotfix/1.4.1
```

**"tag 与分支同时打"** 才能保证"发布可追溯"。

### 五个"分支越管越乱"

**① 长期存在的 feature 分支**

```
3 个月的分支 → 合并时全是冲突（等于重写）
```

**② 直接在 main 上改**

```
没有 review → 出问题无法定位"哪次改的"
```

**③ develop 与 main 长期分叉**

```
每次发布都是一次"大批量合并"（风险集中）
```

**④ 用分支区分环境**

```
dev 分支 = 测试环境，main = 生产
→ 环境与代码耦合，回滚困难
```

**"用分支管环境"** 是反模式（应该用部署流水线管环境）。

**⑤ 没有"分支命名与清理规范"**

```
几百个 stale 分支 → 不知道哪些能删
```

### 一个"分支卫生"清单

```bash
# 已合并到 main 的分支（可删）
git branch --merged main | grep -v main
# 最后提交时间
git for-each-ref --sort=-committerdate refs/heads \
  --format='%(committerdate:short) %(refname:short)'
```

**"每月清理一次已合并分支"**。

### PR 的四个要求

```
① 小而聚焦（< 400 行改动）
② 有描述（改了什么、为什么、怎么验证）
③ 有测试（至少覆盖关键路径）
④ 有 review（至少一人，关键模块两人）
```

**"1000 行的 PR"** 基本没人能认真 review。

### 检查清单

```
□ 分支策略与交付模式匹配
□ feature 分支短命（< 2 天）
□ main 随时可发布
□ release 分支有明确生命周期
□ hotfix 合回 main（不漏）
□ tag 规范（语义化版本）
□ 不用分支区分环境
□ 有分支命名规范
□ 定期清理 stale 分支
□ PR 小而聚焦 + 有描述
□ review 覆盖关键模块
```
