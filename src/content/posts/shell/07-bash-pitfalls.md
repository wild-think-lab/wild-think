---
title: Bash 脚本里那些"看着对却会炸"的写法
description: set -euo pipefail 的边界、管道与子 shell、数组与空格、退出码陷阱，以及十个高频错误。
date: 2026-11-27
tags: [Shell, Bash, 脚本]
---

### 先立三行"地基"

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
```

**作用**：

```
set -e        ：命令失败即退出
set -u        ：未定义变量报错
pipefail      ：管道中任一命令失败，整个管道失败
IFS           ：避免按空格拆词（路径带空格不再被切碎）
```

**但 `set -e` 有大量例外**，不了解反而更容易炸。

### `set -e` 失效的六个场景

**① 命令在 `if` / `while` / `&&` / `||` 里**

```bash
set -e
if grep -q foo file; then   # grep 失败不会退出（在 if 里）
    echo found
fi

false || echo "ok"          # false 不会退出（在 || 里）
```

**这是设计如此**，不是 bug。

**② 命令是函数调用的最后一条、且返回值被判断**

```bash
f() { false; }
if f; then echo yes; fi;    # 不退出（f 在 if 里）
```

**③ 命令在子 shell / 管道中**

```bash
set -e
echo hi | grep nothing      # 只有 pipefail 才会失败
```

**④ 命令在 `$(...)` 里且外层没检查**

```bash
set -e
x=$(false)                  # 会退出（在现代 bash 中）
```

**⑤ 命令在 `!` 取反中**

```bash
! false                     # 不退出
```

**⑥ `local` 掩盖了退出码**

```bash
f() {
    local x=$(false)        # local 的退出码是 0，false 的失败被吞掉
}
```

**修法**：

```bash
f() {
    local x
    x=$(false)
}
```

**这六个场景是真的会坑人的**，尤其第 ⑥ 条。

### 十个高频错误

**① 变量不加引号**

```bash
# 错
rm -rf $dir/          # dir 为空时，等于 rm -rf /（灾难）
cp $file $dst         # 路径带空格就断

# 对
rm -rf "${dir:?}/"    # :? 为空时直接报错退出
cp "$file" "$dst"
```

**`${var:?消息}` 是很强的保护**：

```bash
target="${1:?usage: $0 <target>}"
```

**② 用 `[ ]` 而不是 `[[ ]]`**

```bash
# 错
if [ $str = "a b" ]; then   # 会报 unary operator expected
# 对
if [[ $str == "a b" ]]; then
```

**`[[ ]]` 里可以不加引号**，也不会被 word split。

**③ `for` 遍历命令输出**

```bash
# 错
for f in $(ls *.log); do   # 文件名带空格会断
# 对
for f in *.log; do
```

**更好的**：

```bash
while IFS= read -r line; do
    echo "$line"
done < <(find . -name '*.log')
```

**④ 用 `cat` 做无意义拼接**

```bash
# 错
cat file | grep foo
# 对
grep foo file
```

**这是"UUOC"（useless use of cat），除了浪费一个进程没别的问题，但确实没意义。**

**⑤ 循环里启动大量进程**

```bash
# 慢
for i in $(seq 1 1000); do curl -s url/$i; done

# 快
seq 1 1000 | xargs -P 20 -I{} curl -s url/{}
```

**`-P` 是并行数**，注意别把目标打挂。

**⑥ 忽视 `cd` 失败**

```bash
# 危险
cd /some/dir
rm -rf *            # cd 失败时，在错误的目录里执行了 rm
# 安全
cd /some/dir || exit 1
```

**这个事故现实中非常常见**。

**⑦ 临时文件不清理**

```bash
# 用 trap 保证清理
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
```

**`mktemp` 比 `/tmp/$$` 安全**（防符号链接攻击）。

**⑧ `$?` 被覆盖**

```bash
cmd
echo "done"
if [ $? -ne 0 ]; then   # 此时 $? 是 echo 的退出码
```

**修法**：

```bash
if ! cmd; then
    echo failed
fi
```

**⑨ 数字比较用字符串语法**

```bash
# 错
if [ "$a" > "$b" ]      # 这是字符串比较！10 > 9 为假
# 对
if (( a > b )); then
```

**字符串比较 `>` 是按字典序**，"10" < "9"。

**⑩ 忽略 `IFS` 导致的 split**

```bash
data="a:b:c"
IFS=: read -r x y z <<< "$data"
```

**默认 IFS 是空格/制表/换行，冒号要显式设**。

### 函数与参数处理

```bash
usage() { echo "usage: $0 [-n num] [-f file]"; exit 1; }

num=10
file=""

while getopts ":n:f:h" opt; do
  case $opt in
    n) num=$OPTARG ;;
    f) file=$OPTARG ;;
    h) usage ;;
    :) echo "missing arg for -$OPTARG"; exit 1 ;;
    \?) echo "invalid option -$OPTARG"; exit 1 ;;
  esac
done
```

**`getopts` 的坑**：

```
① 以冒号开头（":n:f:h"）→ 静默模式，错误通过 opt 变量返回
② 必须 while，每轮 getopts 处理一个参数
③ 长的选项（--foo）getopts 不支持，要用 getopt 或手写
```

### 日志与输出规范

```bash
log() { printf '%s [%s] %s\n' "$(date +%F' '%T)" "$1" "$2" >&2; }
log INFO "starting"
log ERROR "failed"

# 全部输出重定向
exec > >(tee -a "$LOG_FILE") 2>&1
```

**注意**：

```
① 日志写 stderr（不污染 stdout 的管道数据）
② 带时间戳（排查时至关重要）
③ 用 tee 同时保留到文件
```

**`exec > >(...)` 的坑**：进程替换在某些环境下（如 cron）不可用。cron 里建议直接 `>> file 2>&1`。

### 幂等性

```bash
# 保证可重复执行
mkdir -p /data/app
ln -sf /opt/app/current /data/app/link
grep -q "line" file || echo "line" >> file
```

**"跑两次不炸"是脚本的基本素养**，尤其在自动化里。

### 一个"安全模板"

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LOG="${LOG:-/tmp/$(basename "$0").log}"

log()  { printf '%s %-5s %s\n' "$(date +%F' '%T)" "$1" "$2" | tee -a "$LOG" >&2; }
die()  { log ERROR "$*"; exit 1; }

main() {
    local target="${1:?usage: $0 <target>}"
    [[ -e $target ]] || die "not found: $target"
    log INFO "processing $target"
    # ...
}

main "$@"
```

**它能覆盖 90% 的脚本场景**。

### 检查清单

```
□ 四行地基（-euo pipefail + IFS）
□ 所有变量加双引号
□ 路径/参数用 ${var:?}
□ 用 [[ ]] 不用 [ ]
□ 不用 for $(ls)
□ cd 后加 || exit
□ mktemp + trap 清理
□ 数字比较用 (( ))
□ 读文件用 while IFS= read -r
□ 日志带时间戳且写 stderr
□ 脚本可重复执行（幂等）
□ shellcheck 跑一遍
```

**`shellcheck script.sh` 是免费的代码审查**，几乎能发现上面 80% 的问题。
