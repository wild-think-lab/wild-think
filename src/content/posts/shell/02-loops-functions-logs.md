---
title: 循环、函数与日志：脚本从"能跑"到"能维护"
description: 批量处理主机、抽公共函数、统一日志格式，让一个脚本能被同事接手。
date: 2026-11-24
tags: [Shell, 脚本, 循环, 函数, 日志]
---

### 批量处理：循环的三种写法

**按行读文件**（主机清单）：

```bash
while IFS= read -r host; do
  [ -z "$host" ] && continue          # 跳过空行
  case "$host" in \#*) continue ;; esac   # 跳过注释
  echo "checking $host"
done < hosts.txt
```

`while read` 比 `for h in $(cat hosts.txt)` 安全得多：后者遇到空格就拆词，遇到特殊字符还会被解释。

**按数组**：

```bash
hosts=(web01 web02 db01)
for h in "${hosts[@]}"; do
  echo "$h"
done
```

**按通配**：

```bash
for f in /var/log/*.log; do
  [ -e "$f" ] || continue     # 没有匹配时通配符会原样保留，必须判断
  ...
done
```

### 函数：把重复逻辑抽出来

```bash
log() {
  local level="$1"; shift
  printf '[%s] [%-5s] %s\n' "$(date '+%F %T')" "$level" "$*"
}

check_http() {
  local url="$1" code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url")"
  [ "$code" = "200" ] && return 0
  log ERROR "HTTP $code: $url"
  return 1
}
```

三条规则：

1. 函数内变量用 `local`，别污染全局。
2. 用 `return` 返回状态，用全局变量或 stdout 返回数据。
3. 日志统一一个函数，格式一致，后面好 `grep`。

### 一个好用的日志格式

```text
[2026-11-24 10:21:33] [INFO ] start backup /var/www
[2026-11-24 10:21:40] [ERROR] tar failed: permission denied
```

固定宽度 + 时间在前，好处是 `grep ERROR`、`awk '{print $2}'` 排序都直接可用。写进文件时再重定向：

```bash
exec >>"/var/log/mytool.log" 2>&1
log INFO "start"
```

`exec` 一次重定向，脚本后续所有输出（含报错）都进日志，不用每行都加 `>>`。

### 并发：不要无脑后台跑

```bash
# 简单的并发上限控制
max=5
for h in "${hosts[@]}"; do
  ( check "$h" ) &
  while [ "$(jobs -rp | wc -l)" -ge "$max" ]; do wait -n; done
done
wait
```

`wait -n` 等"任意一个"结束再发下一个，避免一次起 500 个 ssh 把本机打爆。

真正需要可靠并发时，用 `xargs -P`：

```bash
printf '%s\n' "${hosts[@]}" | xargs -P 8 -I{} sh -c 'check "{}"'
```

### 幂等：脚本能被重复执行

运维脚本最常被重复跑。所以每一步都要"已经做过也不出错"：

```bash
mkdir -p /opt/app            # 而不是 mkdir
grep -q "export PATH=/opt/app/bin:\$PATH" ~/.bashrc || echo '...' >> ~/.bashrc
systemctl is-enabled nginx >/dev/null 2>&1 || systemctl enable nginx
tar ... 2>/dev/null || true
```

幂等不是"高级要求"，是脚本能不能交给别人跑的分界线。

### 本章要点

- 读文件用 `while IFS= read -r`，别 `for $(cat)`。
- 函数内 `local`，日志统一一个函数。
- 并发要设上限，用 `wait -n` 或 `xargs -P`。
- 幂等：重复执行也不出错，是运维脚本的及格线。
