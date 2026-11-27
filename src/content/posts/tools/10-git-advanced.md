---
title: Git 进阶四个命令：rebase、cherry-pick、reflog、bisect
description: 每个命令解决什么真实问题、搞错了怎么救回来、以及团队协作时哪些用法会害人。
date: 2026-11-27
tags: [Git, rebase, 版本控制, 协作]
---

### rebase：把分叉"捋直"

**问题**：本地分支落后主干 20 个提交，直接 merge 会产生一个混乱的合并节点。

```bash
git fetch origin
git rebase origin/main
```

效果：把你的提交"搬到"主干最新位置，历史变直线。

**冲突处理**：

```bash
git rebase origin/main
# 冲突 → 解决 → 
git add <file>
git rebase --continue

# 搞砸了
git rebase --abort
```

**黄金规则**：**只在"没推送过"的本地分支上 rebase**。已推送到共享分支的提交不要 rebase，会重写别人的历史。

如果确实需要（自己一个人的分支）：

```bash
git push --force-with-lease
```

`--force-with-lease` 比 `--force` 安全：如果别人在此期间推过，会拒绝。

### cherry-pick：只摘一个提交

**场景**：在 `develop` 上修了个 bug，现在要把它单独拿到 `release` 分支。

```bash
git log --oneline -5           # 找到 commit hash
git switch release
git cherry-pick a1b2c3d
```

**一次摘多个**：

```bash
git cherry-pick a1b2c3d..f4e5d6a      # 区间（不含起点）
git cherry-pick a1b2c3d f4e5d6a       # 指定多个
```

**只要改动不要提交信息**：

```bash
git cherry-pick -n a1b2c3d     # 应用到工作区，不提交
```

**冲突**：

```bash
git cherry-pick --continue
git cherry-pick --abort
```

**注意**：cherry-pick 会产生"内容相同但 hash 不同"的提交。以后两个分支合并时，Git 通常能识别（patch-id 相同），但**不是 100% 可靠**，复杂冲突时可能出现重复改动。

### reflog：救命用的

**场景**：`git reset --hard` 之后发现删错了，或者 rebase 搞乱了历史。

```bash
git reflog
# a1b2c3d HEAD@{0}: reset: moving to HEAD~3
# 9f8e7d6 HEAD@{1}: commit: 加了个功能
```

恢复：

```bash
git reset --hard 9f8e7d6        # 回到那个提交
# 或只恢复某个文件
git checkout 9f8e7d6 -- path/to/file
```

**reflog 会保留 90 天**（`gc.reflogExpire` 默认 90 天），这期间几乎所有"误删"都能找回。

**日常救急三板斧**：

```
① 我刚 commit 错了 → git commit --amend
② 我 reset 错了 → git reflog + git reset --hard <hash>
③ 我 rebase 乱了 → git reflog + git reset --hard HEAD@{N}
```

### bisect：二分定位是哪个提交引入的 bug

**场景**：300 个提交里有一个引入了 bug，不知道是哪个。

```bash
git bisect start
git bisect bad                 # 当前版本有问题
git bisect good v1.2.0         # 这个 tag 是好的

# Git 会 checkout 中间的提交，你测试后告诉它结果
# 循环约 log2(300) ≈ 8 次
git bisect good / git bisect bad
```

**自动化**（有测试脚本时最爽）：

```bash
git bisect start HEAD v1.2.0
git bisect run ./test.sh
# test.sh 返回 0 = good，非 0 = bad
```

Git 会自动跑完并告诉你"第一个坏提交是 xxx"。

**结束**：

```bash
git bisect reset
```

### 四个容易害人的用法

**① 在共享分支上 rebase**

会重写别人的提交历史，导致所有人冲突。**共享分支只用 merge**。

**② `git push -f` 不带 lease**

覆盖别人刚推的提交。永远用 `--force-with-lease`。

**③ `git reset --hard` 前不 commit**

工作区改动直接消失（reflog 里没有，因为没提交过）。

```bash
# 想丢弃改动但留个后路
git stash -u        # 包括未跟踪文件
```

**④ cherry-pick 后又 merge 同一分支**

可能出现同一改动被应用两次（内容冲突或重复）。建议：**要么 cherry-pick，要么 merge，别两者都用**。

### 三个实用别名

```bash
git config --global alias.lg "log --oneline --graph --decorate -20"
git config --global alias.undo "reset --soft HEAD~1"     # 撤销最后一次提交，改动留在工作区
git config --global alias.last "log -1 --stat"
```

### 团队协作的三条约定

```
① 主干（main）只接受 PR/MR，不直接 push
② 个人分支用 rebase 保持整洁，合并时用 squash merge
③ 提交信息统一格式：type(scope): subject
```

提交信息示例：

```
feat(api): 增加订单导出接口
fix(db): 修复连接池耗尽问题
docs(readme): 补充部署说明
```

### 检查清单

```
□ 只在自己未推送的分支上 rebase
□ 强推用 --force-with-lease
□ reset 前先 commit 或 stash
□ 会看 reflog（误操作的第一救援手段）
□ 用 bisect + 测试脚本定位回归
□ 共享分支只 merge 不 rebase
```
