---
title: 函数与日志：脚本也要能排障
module: 熟练篇
summary: 把重复逻辑收进函数，所有输出进日志，出错时留下证据。这一章决定你的脚本是"能跑"还是"能维护"。
minutes: 12
---

### 为什么要函数

同一个脚本里，"检查目录"要做三次，"打日志"要做二十次。不抽函数的后果是：改一处逻辑要改三个地方，且极容易漏。

```bash
#!/usr/bin/env bash
set -euo pipefail

log()  { printf '%s [%s] %s\n' "$(date '+%F %T')" "$1" "$2"; }
info() { log INFO  "$*"; }
warn() { log WARN  "$*" >&2; }
die()  { log ERROR "$*" >&2; exit 1; }
```

有了这四行，后面所有输出都变成了结构化日志，直接能进日志系统检索。

### 函数的标准写法

```bash
ensure_dir() {
  local dir=$1
  if [ -d "$dir" ]; then
    info "目录已存在: $dir"
    return 0
  fi
  mkdir -p "$dir" || die "创建目录失败: $dir"
}

ensure_dir /var/log/app
```

两个要点：

- **局部变量用 `local`**，否则会污染全局（脚本里变量是全局的）。
- **用 `local dir=$1` 而不是 `local dir="$1"`** 是习惯差异，但引用时一定加引号。

### 返回值：用退出码传状态，用 echo 传数据

这是最容易混淆的地方。

```bash
get_ip() {
  local host=$1
  getent hosts "$host" | awk '{print $1}'
}

if ip=$(get_ip web01); then
  info "解析到: $ip"
else
  warn "解析失败"
fi
```

规则：**函数用 `return` 返回 0/1（成功/失败），用 `echo` 返回数据给调用方接**。

不要试图用 `return "字符串"`——`return` 只能返回 0–255 的数字。

### 日志该记什么

一个能排障的脚本，日志至少包含四要素：

```
时间 + 级别 + 模块/主机 + 具体动作与结果
```

```bash
info "开始备份 database=app target=/backup/app-20261127.tar.gz"
info "备份完成 size=3.2G elapsed=124s"
warn "旧备份清理跳过：目录不可写"
```

**要记"开始"和"完成"**，只记结果的话，出问题你无法判断它卡在哪一步。

### 输出分离：stdout 与 stderr

```bash
info() { printf '%s\n' "$*"; }          # 正常信息 → stdout
warn() { printf '%s\n' "$*" >&2; }      # 警告 → stderr
```

好处：`./script > result.txt` 时，错误仍在终端可见；`2>>err.log` 可以单独收集错误。

### 结构化日志（可被采集）

```bash
jlog() {
  local level=$1; shift
  printf '{"time":"%s","level":"%s","msg":"%s"}\n' \
    "$(date -Iseconds)" "$level" "$*"
}
jlog info "backup start file=app.tar.gz"
```

输出一行一个 JSON，Filebeat/Promtail 直接能解析出字段，比纯文本强得多。

### 结合 set -e 的坑

```bash
set -e
count=$(grep -c ERROR app.log)     # 没有匹配时 grep 返回 1，脚本直接退出
```

解法：

```bash
count=$(grep -c ERROR app.log || true)
# 或
if ! count=$(grep -c ERROR app.log); then count=0; fi
```

**所有"可能正常失败"的命令都要显式处理**，否则 `set -e` 会把正常情况当异常。

### 一个完整的小工具

```bash
#!/usr/bin/env bash
set -euo pipefail

readonly APP=myapp
readonly LOG_DIR=/var/log/$APP
readonly KEEP=14

log()  { printf '%s [%s] %s\n' "$(date '+%F %T')" "$1" "$2"; }
info() { log INFO "$*"; }
die()  { log ERROR "$*" >&2; exit 1; }

rotate() {
  local dir=$1 keep=$2
  [ -d "$dir" ] || die "目录不存在: $dir"
  find "$dir" -name '*.log.*' -mtime +"$keep" -print -delete | while read -r f; do
    info "删除过期: $f"
  done
}

main() {
  info "任务开始 app=$APP keep=${KEEP}d"
  rotate "$LOG_DIR" "$KEEP"
  info "任务结束"
}

main "$@"
```

结构：日志函数 → 业务函数 → `main` → `main "$@"`。这个骨架可以直接复用，只换业务函数。

### 本章验证

1. 把上一章的批量检查脚本改造成"函数 + 统一日志"结构。
2. 让所有警告走 stderr，验证 `./script 2>/dev/null` 只剩正常输出。
3. 故意让 `grep` 无匹配，确认脚本仍继续执行。

函数和日志不是为了"看起来专业"，是为了**三个月后你还能看懂自己写的脚本**。
