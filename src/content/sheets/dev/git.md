---
title: Git 速查
summary: 日常提交、分支与合并策略、撤销的四种层次、找"谁改的这行"、冲突解决、rebase 与 cherry-pick 的正确姿势。
group: 开发
order: 6
tags: [Git, 版本控制, 协作]
---

## 日常一圈

```bash
git status -sb
git diff                # 未暂存
git diff --staged       # 已暂存
git add -p              # 逐块选择，比 git add . 好太多
git commit -m "fix: 修正健康检查超时"
git push -u origin HEAD
```

提交信息用 `type: 内容` 的约定（feat/fix/docs/refactor/chore），后续 changelog 能自动生成。

## 分支

```bash
git switch -c feat/wsus-report      # 新建并切换
git switch main
git branch -vv                      # 本地分支与上游对应
git branch -d merged-branch
git fetch --prune                   # 清理远端已删的分支
git remote -v
```

## 合并 vs 变基，怎么选

| 场景 | 用什么 | 结果 |
| --- | --- | --- |
| 主干合入特性分支 | `merge --no-ff` | 保留一个合并节点，历史可追溯 |
| 特性分支追主干 | `rebase` | 线性历史，冲突在本地一个个解决 |
| 已推送的公共分支 | **只能 merge** | rebase 会改写别人拉过的历史 |

```bash
git merge --no-ff feat/x
git rebase origin/main            # 只在本地未推送分支上做
git rebase -i HEAD~5              # 整理最近 5 个提交（squash/fixup）
```

`rebase -i` 之后要 `git push --force-with-lease`，不要用 `--force`（前者会在远端被别人改过时拒绝）。

## 撤销的四种层次

```bash
git restore file.txt                 # 丢弃工作区改动
git restore --staged file.txt        # 取消暂存（内容保留）
git commit --amend                   # 改最后一次提交（未推送时）
git reset --soft HEAD~1              # 撤销提交，改动留在暂存区
git reset --mixed HEAD~1             # 撤销提交与暂存，改动留在工作区
git reset --hard HEAD~1              # 全丢（危险，先 git stash 或建分支）
git revert <sha>                     # 生成一个反向提交，适合已推送
```

记法：`--soft` 只动 HEAD，`--mixed` 再动 index，`--hard` 连工作区一起。

## 找回"删掉的东西"

```bash
git reflog                       # 一切 HEAD 移动的记录，救命入口
git checkout -b rescue <sha>     # 从 reflog 里捞回
git fsck --lost-found            # 找游离对象
git stash list
git stash pop
```

**误 `reset --hard` 之后第一件事是 `git reflog`**，别急着重新写代码。

## 查历史与责任人

```bash
git log --oneline --graph --decorate -20
git log -p -- src/app.go
git log -S 'MaxOpenConns' --oneline      # 找某段字符串何时被引入
git log --author=wang --since=2026-10-01
git blame -L 40,60 src/app.go
git show <sha> --stat
```

`-S`（pickaxe）是"这个配置什么时候加的"最快的答案。

## 冲突

```bash
git merge origin/main
git status                 # 列出冲突文件
git diff --name-only --diff-filter=U
# 编辑冲突标记，或选一边
git checkout --ours file
git checkout --theirs file
git add file && git merge --continue
git merge --abort          # 放弃这次合并
```

`rerere` 能记住你解决过的冲突，重复变基时自动复用：

```bash
git config --global rerere.enabled true
```

## 挑单个提交

```bash
git cherry-pick <sha>
git cherry-pick <sha1>^..<sha2>     # 一段
git cherry-pick -n <sha>             # 只应用改动不提交
```

hotfix 从主干挑到 release 分支就是靠它，注意挑完要解决语义冲突（能编译不代表逻辑对）。

## 一些必备配置

```bash
git config --global user.name "wild-think"
git config --global user.email "wild-think@users.noreply.github.com"
git config --global init.defaultBranch main
git config --global pull.rebase true
git config --global core.autocrlf input   # Windows 上建议 input
git config --global alias.lg "log --oneline --graph --decorate -20"
```

## 仓库体检

```bash
git count-objects -vH         # 仓库体积
git gc --aggressive --prune=now
git remote prune origin
du -sh .git
```

`.git` 比工作区还大，通常是历史里提交过大文件。用 `git filter-repo` 清理（会改写历史，需全员重新拉取）。
