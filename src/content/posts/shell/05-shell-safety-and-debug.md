---
title: Shell 脚本的"安全阀"：set -euo pipefail 到底做了什么
description: 三个选项各自的真实行为、哪些情况它救不了你、trap 清理的正确写法、以及调试脚本的四种手段。
date: 2026-11-27
tags: [Shell, 脚本, 调试, 健壮性]
---

### 三个选项的真实行为

```bash
set -euo pipefail
```

| 选项 | 作用 | 常见误解 |
| --- | --- | --- |
| `-e` | 命令失败（非 0）立即退出 | **在 `if`/`while`/`&&`/`\|\|` 里的失败不触发** |
| `-u` | 使用未定义变量时报错 | `$1` 未传也会报错（要有默认值） |
| `-o pipefail` | 管道中任一命令失败即整体失败 | 不加时只看最后一个命令 |

**`-e` 的坑**（它比你想的弱）：

```bash
set -e
false || true        # 不退出（在 || 里）
if false; then ...; fi   # 不退出（在条件里）
local x=$(false)     # 不退出（local 的返回值掩盖了）
```

`local x=$(cmd)` 是经典陷阱：`local` 本身成功，所以 `-e` 看不到 `cmd` 失败。

**正确写法**：

```bash
local x
x=$(cmd) || { echo "cmd failed"; exit 1; }
```

### 完整脚本骨架

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LOG="/var/log/$(basename "$0" .sh).log"

log()  { printf '%s [%s] %s\n' "$(date '+%F %T')" "$1" "$2" | tee -a "$LOG"; }
die()  { log ERROR "$*"; exit 1; }

cleanup() {
    local rc=$?
    log INFO "exit rc=$rc"
    # 清理临时文件、解锁、停掉子进程
    [[ -n "${TMPDIR_WORK:-}" ]] && rm -rf "$TMPDIR_WORK"
    exit $rc
}
trap cleanup EXIT

trap 'log ERROR "line $LINENO interrupted"; exit 130' INT TERM
```

**`trap ... EXIT` 一定要保留 `$?`**：否则退出码被 `exit 0` 覆盖，上层无法判断成败。

### trap 的三个实用场景

**① 临时文件必删**

```bash
TMPDIR_WORK=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK"' EXIT
```

**② 中途失败也要恢复配置**

```bash
cp /etc/nginx/nginx.conf /tmp/nginx.bak
trap 'cp /tmp/nginx.bak /etc/nginx/nginx.conf; nginx -s reload' ERR EXIT
```

**③ 防止并发执行**

```bash
LOCK=/var/run/backup.lock
exec 9>"$LOCK"
flock -n 9 || die "another instance running"
```

`flock` 比"检查 pid 文件"可靠得多（进程崩溃后锁自动释放）。

### 四种调试手段

**① `bash -x`**

```bash
bash -x script.sh 2>&1 | head -50
```

输出每一行展开后的命令，前缀 `+`。

**② 局部调试**

```bash
set -x              # 从这里开始
...要调试的代码...
set +x              # 关掉
```

**③ `PS4` 带行号**

```bash
export PS4='+ ${BASH_SOURCE}:${LINENO}: '
bash -x script.sh
```

**④ `shellcheck`**

```bash
shellcheck script.sh
```

它会抓出：未引用变量、`[ ]` 与 `[[ ]]` 混用、`for f in $(ls)`、未处理 `cd` 失败等。

**每次提交脚本前跑一遍 shellcheck**，能避免 80% 的低级问题。

### 变量引用必须加引号

```bash
# 差：路径含空格 / 空变量时会炸
rm -rf $DIR/*

# 好
rm -rf "${DIR:?DIR is empty}"/…
```

`${VAR:?msg}` 在变量为空时直接报错退出，**比 `rm -rf /` 安全得多**。

**危险脚本必备**：

```bash
: "${TARGET_DIR:?must set TARGET_DIR}"
[[ "$TARGET_DIR" == / ]] && die "refuse to operate on /"
```

### 参数解析

**少量参数**（< 3 个）：

```bash
usage() { echo "usage: $0 -e env -f file"; exit 1; }
while getopts ":e:f:h" opt; do
  case $opt in
    e) ENV=$OPTARG ;;
    f) FILE=$OPTARG ;;
    h) usage ;;
    :) die "option -$OPTARG requires a value" ;;
    *) usage ;;
  esac
done
[[ -n "${ENV:-}" && -n "${FILE:-}" ]] || usage
```

**多参数/长选项**：用 `getopt`（不是 `getopts`）：

```bash
OPTS=$(getopt -o e:f: --long env:,file: -n "$0" -- "$@") || exit 1
eval set -- "$OPTS"
while true; do
  case "$1" in
    -e|--env) ENV=$2; shift 2 ;;
    -f|--file) FILE=$2; shift 2 ;;
    --) shift; break ;;
  esac
done
```

### 日志与输出分离

```bash
# 数据走 stdout（可被管道处理），日志走 stderr
log() { echo "$*" >&2; }

# 只在需要时输出结果
result=$(compute_something)
echo "$result"
```

这样 `./script.sh > data.txt` 时日志不会污染数据。

### 检查清单

```
□ 开头 set -euo pipefail
□ IFS 设为换行与制表（按行处理更安全）
□ trap EXIT 保留退出码
□ 临时文件用 mktemp + trap 清理
□ 并发用 flock 而不是 pid 文件
□ 变量一律加引号，危险变量用 ${VAR:?}
□ 危险路径做白名单校验
□ 提交前跑 shellcheck
```
