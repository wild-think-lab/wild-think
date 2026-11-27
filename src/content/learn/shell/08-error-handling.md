---
title: 错误处理：set -e 不是万能的
module: 熟练篇
summary: set -e 的六个例外、显式 if 校验、清理与 trap、幂等与重入，以及五个"脚本静默跑错"的原因。
minutes: 40
---

### set -e 的六个例外（必须记）

```
① 命令在 if/while/until 条件中
② 命令在 && / || 列表中（非最后一条）
③ 命令前面有 !
④ 管道中（默认只看最后一条，除非 pipefail）
⑤ 命令在 $(...) 但赋值给变量时（部分场景）
⑥ 函数被调用时（取决于调用上下文）
```

**结论**：

```
set -e 提供"基本保护"，关键步骤仍要显式校验
```

### 显式校验（推荐写法）

```bash
if ! mkdir -p "$dir"; then
  log "mkdir failed: $dir"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  log "jq not found"
  exit 1
fi
```

**"依赖 set -e 兜底"** → 一旦落在上面六个例外里，就静默继续。

### 清理：trap 必须写

```bash
tmpdir=$(mktemp -d)
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT INT TERM
```

**"中途失败留一堆临时文件"** → 磁盘慢慢被吃掉。

### 幂等与重入

```bash
# 目录存在也没关系
mkdir -p "$dir"

# 文件存在才写
if [[ ! -f "$cfg" ]]; then cp "$tpl" "$cfg"; fi

# 用锁防并发
exec 9>/var/lock/myscript.lock
flock -n 9 || { log "already running"; exit 0; }
```

**"脚本跑两遍结果不同"** → 不幂等，无法在故障后安全重跑（重跑是运维的日常）。

### 重试（限次数 + 退避）

```bash
retry() {
  local n=0 max=3
  until "$@"; do
    n=$((n+1))
    (( n >= max )) && { log "retry exhausted: $*"; return 1; }
    sleep $(( n * 2 ))
  done
}
retry curl -fsS -o /dev/null http://svc/health
```

**"无限重试"** 会把故障放大（尤其在下游已经挂了的时候）。

### 五个"静默跑错"

**① 管道中间失败**

```
set -o pipefail 缺失
```

**② 变量未定义**

```
set -u 缺失 → 空变量导致路径变 "/"
（风险：rm -rf "$dir" 里 dir 为空）
```

**③ 通配符没匹配到**

```
rm -rf $dir/* 当没有文件时 → 传字面量
（用 shopt -s nullglob 或先判断）
```

**④ 命令存在但参数错**

```
cmd --wrong 返回 2，脚本只看 0/非 0 就继续
```

**⑤ 日志没写**

```
echo 到 stdout 被重定向丢了 → 事后无线索
```

### 一段可复用的安全骨架

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

log() { printf '%s [%s] %s\n' "$(date '+%F %T')" "${2:-INFO}" "$1" >&2; }
die() { log "$1" ERROR; exit "${2:-1}"; }

main() {
  [[ $# -ge 1 ]] || die "usage: $0 <target>"
  local target=$1
  [[ -n "$target" ]] || die "empty target"
  ...
}

main "$@"
```

### 检查清单

```
□ set -Eeuo pipefail
□ 关键命令显式 if 校验
□ 有 trap 清理临时资源
□ 有 flock 防并发
□ 幂等（可重复执行）
□ 重试有上限与退避
□ 变量都有默认/校验
□ 知道 set -e 的六个例外
□ 日志走 stderr 带时间戳
□ 退出码有语义
```
