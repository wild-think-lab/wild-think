---
title: Git 速查（进阶）
summary: 撤销/回滚/找回丢失提交/变基/挑选提交/二分定位/子模块，附"这个操作会不会丢数据"的判断。
group: Dev
order: 1
tags: [git, 版本控制, 排错]
---

## 一、三个区域与四个状态

```
工作区（working）  → git add → 暂存区（index） → git commit → 仓库（HEAD）
                        ← git checkout -- file  ←  git reset
```

## 二、撤销（按"是否已提交/是否已推送"分）

| 场景 | 命令 | 会丢数据吗 |
| --- | --- | --- |
| 丢弃工作区改动 | `git restore file` | 会（未提交的改动） |
| 取消暂存（保留改动） | `git restore --staged file` | 不会 |
| 撤销最近一次提交（保留改动） | `git reset --soft HEAD~1` | 不会 |
| 撤销提交并取消暂存（保留改动） | `git reset HEAD~1` | 不会（改动还在工作区） |
| 彻底丢弃提交与改动 | `git reset --hard HEAD~1` | **会** |
| 撤销已推送的提交 | `git revert <sha>` | 不会（生成反向提交） |

**最安全的原则**：

```
已推送 → 用 revert（追加一个反向提交）
未推送 → 可以 reset（本地历史重写）
```

**已推送后 reset + force push** 会让协作者的历史分叉，除非团队约定否则不要做。

## 三、找回"丢失"的提交

```bash
git reflog                     # 所有 HEAD 移动记录（默认保留 90 天）
git reflog show main

# 找回
git reset --hard <sha>         # 回到某个 reflog 里的点
git checkout -b rescue <sha>   # 或者建分支保住
```

**`reflog` 是 Git 的救命功能**：hard reset、变基出错、误删分支都能找回来。

## 四、查看改动

```bash
git status -sb                 # 简洁状态
git diff                       # 工作区 vs 暂存区
git diff --staged              # 暂存区 vs HEAD
git diff main...feature        # 两分支分叉后的差异（... 只看 feature 的改动）
git log --oneline --graph --all --decorate   # 图形化历史
git log -p --follow -- path/to/file          # 追踪文件历史（含重命名）
git log -S"function_name" --oneline           # 按代码内容搜索（谁引入/删除）
git blame -L 10,20 file                       # 指定行
```

**`git diff main...feature`** 与 `main..feature` 的区别：

```
A..B    B 有而 A 没有的提交
A...B   从共同祖先到 B 的改动（code review 应该用这个）
```

## 五、变基（rebase）

```bash
git rebase main                # 把当前分支移到 main 之上
git rebase -i HEAD~3           # 交互式整理最近 3 个提交
```

**`-i` 的六个动作**：

```
pick    保留
reword  改提交信息
edit    停下来修改
squash  合并到上一个（保留信息）
fixup   合并到上一个（丢弃信息）
drop    删除
```

**黄金规则**：**不要对已推送的公共分支 rebase**。

## 六、挑提交

```bash
git cherry-pick <sha>                  # 把某个提交应用到当前分支
git cherry-pick <a>..<b>               # 区间（不含 a）
git cherry-pick -n <sha>               # 不自动提交（便于合并多个）
```

冲突时：

```bash
git status                 # 看冲突文件
# 编辑解决
git add <file>
git cherry-pick --continue
# 或放弃
git cherry-pick --abort
```

## 七、二分定位（找引入 bug 的提交）

```bash
git bisect start
git bisect bad                 # 当前是坏的
git bisect good <old-sha>      # 这个旧提交是好的
# Git 会切到中间提交，你测试后告诉它
git bisect good / git bisect bad
# 最后会输出"第一个坏提交"
git bisect reset
```

**自动化**：

```bash
git bisect run ./test.sh       # 脚本返回 0 = good，非 0 = bad
```

**这是排"什么时候开始坏的"最快的方法**（log2(n) 次测试）。

## 八、stash

```bash
git stash                      # 暂存当前改动
git stash -u                   # 含未跟踪文件
git stash list
git stash pop                  # 恢复并删除
git stash apply stash@{1}      # 恢复但保留
git stash drop stash@{0}
git stash show -p stash@{0}    # 看内容
```

## 九、分支操作

```bash
git switch -c feature          # 新建并切换
git switch main
git branch -d feature          # 删除（已合并）
git branch -D feature          # 强制删除
git branch -m old new          # 重命名
git push origin --delete feature
```

**`switch` 与 `checkout` 的区别**：`switch` 只切分支（语义清晰），`checkout` 还能切文件/提交（容易误用）。

## 十、远程

```bash
git remote -v
git fetch --prune              # 拉取并清理已删除的远程分支引用
git push -u origin feature     # 建立 upstream
git push --force-with-lease    # 强制推送（比 --force 安全：别人推过就拒绝）
```

**永远用 `--force-with-lease` 而不是 `--force`**。

## 十一、子模块

```bash
git submodule add <url> path
git submodule update --init --recursive
git submodule foreach 'git pull origin main'
```

**子模块的坑**：克隆时默认不拉子模块内容，要 `--recursive`。

## 十二、配置

```bash
git config --global user.name "name"
git config --global user.email "email"
git config --global core.autocrlf input      # Windows→LF，Linux 不变
git config --global pull.rebase true         # pull 用 rebase（避免 merge 提交）
git config --global init.defaultBranch main
git config --global alias.lg "log --oneline --graph --decorate --all"
```

## 十三、找回被删的分支

```bash
git reflog                     # 找到分支最后一个提交
git branch recovered <sha>
```

## 十四、常见问题

| 现象 | 原因/处理 |
| --- | --- |
| `detached HEAD` | 切到了提交而不是分支；`git switch -c new` 保住 |
| 合并冲突 | 编辑后 `git add` + `commit`（或 `merge --continue`） |
| push 被拒（non-fast-forward） | 先 `fetch` + `rebase`，不要硬推 |
| 提交了密码 | `git filter-repo` 重写历史 + 立刻轮换密码 |
| 文件大小超限 | 用 `git lfs` |
| 换行符全变了 | 配 `core.autocrlf` + `.gitattributes` |

## 十五、安全操作清单

```
□ 已推送的提交不用 reset，用 revert
□ rebase 只用于本地/未推送分支
□ 强制推送用 --force-with-lease
□ 危险操作前先 git branch backup
□ 大改动前 git stash 或提交
□ 定期 git reflog 确认历史（它是最后的保险）
```
