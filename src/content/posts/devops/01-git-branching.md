---
title: Git 分支模型：小团队别再照抄 GitFlow
description: 四种分支策略的适用规模、各自代价，以及一条"主干 + 短分支 + 发布标签"的最小可用路线。
date: 2021-10-04
tags: [DevOps, Git, 分支模型, 协作]
---

### 分支模型是协作协议

它解决的是：**谁能往哪推、什么时候合并、线上代码对应哪个提交**。选错的代价不是"不规范"，而是天天处理冲突、发布靠手工、回滚找不到点。

### 四种常见模型

| 模型 | 结构 | 适合 | 代价 |
| --- | --- | --- | --- |
| GitFlow | main / develop / feature / release / hotfix | 版本化工期长的产品 | 分支多，合并成本高 |
| GitHub Flow | main + 短 feature 分支 + PR | 持续部署的团队 | 依赖自动化测试 |
| Trunk-Based | 只有 main，小步提交 | 成熟 CI、能随时发布 | 对测试与开关要求高 |
| 环境分支 | dev / test / prod | 传统企业 | 分支间长期漂移，合并灾难 |

**GitFlow 是 2010 年为"有版本发布节奏"的项目设计的**。小团队天天发版却照抄它，等于给自己加了四道手续。

### 推荐的最小可用路线

```text
main（永远可发布）
 ├─ feature/xxx（从 main 开，1–3 天内合并）
 ├─ fix/xxx
 └─ tag v1.2.3（发布点）
```

规则只有四条：

1. `main` 保护：不允许直接推，必须 PR + 至少一人 review + CI 通过。
2. 分支寿命 ≤ 3 天，长了就拆小。
3. 发布打 tag，**tag 就是线上版本号**。
4. 回滚 = 重新部署上一个 tag，不是 `git revert` 一堆提交。

### 提交信息：让三个月后的自己看得懂

```text
feat(api): 新增订单导出接口
fix(auth): 修复 token 过期后未刷新导致的 401
docs: 补充部署说明
refactor(db): 拆分查询逻辑，不改行为
chore(ci): 缓存 node_modules
```

`type(scope): 摘要` 的格式，好处是能自动生成变更日志（用 `conventional-changelog`），也方便 `git log --grep="fix(auth)"`。

**一次提交只做一件事**。把"改格式 + 改逻辑 + 升依赖"混在一个提交里，review 和回滚都会痛苦。

### 冲突的正确处理方式

```bash
git fetch origin
git rebase origin/main      # 把自己的提交接到最新 main 上
# 解决冲突后
git add -A && git rebase --continue
```

三条原则：

- **谁的分支谁负责 rebase**，别让别人的提交替自己解冲突。
- 冲突多说明分支活太久，或改动范围重叠——回去拆小。
- 已推送的公共分支不要 rebase，会改写别人的历史。

### 别把二进制和大文件塞进 Git

```bash
# .gitignore 常见项
node_modules/
dist/
*.log
.env
```

仓库体积一旦涨上去很难降。大文件用 Git LFS，密钥用环境变量或密钥管理，**永不提交 `.env`**——这是泄露事故的第一大来源。

### 一个典型事故

```text
现象：线上代码和 main 不一致，回滚后仍然报错
查因：发布时是从某人的本地分支手工 scp 上去的，没人知道那个分支是什么
改进：发布只允许从 tag 构建镜像；制品带上 commit sha
```

### 本章要点

- GitFlow 适合版本化产品，小团队优先 GitHub Flow 或 Trunk-Based。
- main 受保护、分支短、发布打 tag，三条就够用。
- 提交信息写 type(scope)，一次提交一件事。
- 制品必须能追溯到 commit，否则回滚是赌博。
