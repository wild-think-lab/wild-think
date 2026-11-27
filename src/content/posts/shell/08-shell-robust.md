---
title: Shell 脚本健壮性：从"能跑"到"敢放到 cron 里"
description: 六个必备开关、错误处理与清理、日志与并发锁，以及五个"脚本在生产上翻车"的原因。
date: 2023-09-15
tags: [Shell, 脚本, 运维]
---

### 六个必备开关

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
```

**逐个解释**：

```
-e          ：命令失败即退出
-u          ：使用未定义变量即退出
-o pipefail ：管道中任一命令失败即失败
IFS         ：按换行/制表符分词（避免文件名带空格出错）
```

**"没有 -e"的脚本"出错继续跑"，最后写出一堆脏数据**。

**加上 trap**：

```bash
trap 'echo "[ERROR] line $LINENO failed" >&2' ERR
```

### 错误处理与清理

```bash
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cleanup() {
  [[ -n "${lockdir:-}" ]] && rmdir "$lockdir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
```

**"临时文件不清理"** 会在 /tmp 里堆到磁盘满。

### 三个"必须检查"的地方

```bash
# 1) 参数
[[ $# -ge 1 ]] || { echo "usage: $0 <dir>" >&2; exit 2; }

# 2) 依赖
command -v rsync >/dev/null || { echo "rsync missing" >&2; exit 3; }

# 3) 前置条件
[[ -d "$src" ]] || { echo "src not found: $src" >&2; exit 4; }
```

**"脚本第一步就校验"** 比"跑到一半失败"好得多。

### 日志

```bash
log() { printf '%s [%s] %s\n' "$(date -Is)" "$1" "$2" >> "$LOG"; }
log INFO "start backup"
```

**要点**：

```
① 带时间戳（否则无法排查）
② 分级别（INFO/WARN/ERROR）
③ 输出到文件 + 关键信息到 stderr
```

**"echo 到 stdout 然后 cron 发邮件"** 是原始做法（邮件会被淹没）。

### 并发锁（cron 里最重要）

```bash
lockdir=/var/lock/backup.lock
mkdir "$lockdir" 2>/dev/null || { echo "already running" >&2; exit 0; }
trap 'rmdir "$lockdir"' EXIT
```

**"上一轮没跑完，下一轮又起"** 会造成数据错乱/资源争抢。

**更稳的写法（flock）**：

```bash
exec 9>/var/lock/backup.lock
flock -n 9 || { echo "locked" >&2; exit 0; }
```

**`-n`（non-blocking）** 拿不到锁立刻退出。

### 五个"脚本在生产上翻车"的原因

**① 没有 `set -e`**

```
mysqldump 失败 → 脚本继续 → 生成空备份文件 → 监控显示"成功"
```

**② 变量没引号**

```bash
rm -rf $DIR/      # DIR 为空 → rm -rf /
```

**必须**：

```bash
rm -rf "${DIR:?}/"    # DIR 为空则报错退出
```

**"`rm -rf $DIR` 是历史上最贵的 bug"**。

**③ 文件名含空格/换行**

```bash
for f in $(ls); do    # 遇到空格就断
```

**正确**：

```bash
find . -type f -print0 | while IFS= read -r -d '' f; do
```

**④ 没考虑"部分失败"**

```
拷贝了 50% 的文件 → 脚本认为成功
→ 用"校验和/数量比对"确认
```

**⑤ 环境差异**

```
cron 的 PATH 与交互 shell 不同
→ 脚本里用绝对路径，或显式设置 PATH
```

**"手动跑正常，cron 跑失败"** 90% 是 PATH/环境变量。

### 一个"能用"的模板

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

LOG=/var/log/backup.log
log() { printf '%s %-5s %s\n' "$(date -Is)" "$1" "$2" >> "$LOG"; }

exec 9>/var/lock/backup.lock
flock -n 9 || { log WARN "already running"; exit 0; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

src=${1:?usage: $0 <src>}
[[ -d "$src" ]] || { log ERROR "no src: $src"; exit 1; }

log INFO "start $src"
rsync -a --delete "$src/" /backup/data/ || { log ERROR "rsync failed"; exit 1; }

count=$(find /backup/data -type f | wc -l)
log INFO "done, files=$count"
```

**这个模板覆盖了：锁、清理、校验、日志、错误退出**。

### 用 shellcheck 兜底

```bash
shellcheck script.sh
```

**它最常抓到**：

```
① 未加引号的变量
② 无效的 test 语法
③ 数组用法错误
```

**"所有脚本进 CI 前跑一次 shellcheck"** 是低成本高收益。

### 检查清单

```
□ 有 set -euo pipefail + IFS
□ 有 trap 清理（tmp/锁）
□ 校验参数、依赖、前置条件
□ 日志带时间戳与级别
□ 有并发锁（flock 优先）
□ 变量都加引号
□ 用 find -print0 处理文件名
□ 有"结果校验"（数量/校验和）
□ 用绝对路径（cron 场景）
□ 跑过 shellcheck
```
