---
title: 在面试里手写命令与脚本：Shell 题的三类考法
description: 面试常问的三类 Shell 题：统计类（一条流水线答完）、脚本类（参数与错误处理）、排障类（现场定位）。每题给思路与参考答案。
date: 2022-07-27
tags: [面试, Shell, 脚本, 求职]
---

### 面试官在考什么

Shell 题不是为了考"你记得多少参数"，而是三件事：

1. **有没有把问题拆成流水线的思维**（能不能用 grep/awk/sort 拼出答案）。
2. **知不知道脚本要处理失败**（set -e、参数校验、退出码）。
3. **能不能在真实环境里定位问题**（不是背命令，是知道先看什么）。

### 第一类：统计题（一条流水线）

**题 1：统计 access.log 里访问量前 10 的 IP**

```bash
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -10
```

面试官追问"如果日志带 IPv6 和端口怎么写"：

```bash
awk -F' ' '{split($1,a,":"); print a[1]}' access.log | sort | uniq -c | sort -rn | head
```

或者更稳的：`grep -oP '^\K[0-9a-f.:]+'`。

**题 2：统计每个状态码出现次数**

```bash
awk '{print $9}' access.log | sort | uniq -c | sort -rn
```

**题 3：找出 5xx 里响应时间最长的 5 个请求（含 URL）**

日志格式假设含 `rt=`：

```bash
grep ' 5[0-9][0-9] ' access.log \
| awk -F'rt=' '{split($2,a," "); print a[1], $0}' \
| sort -rn | head -5
```

**题 4：把目录下所有 `.log` 超过 100MB 的按大小排序**

```bash
find /var/log -type f -name '*.log' -size +100M -printf '%s\t%p\n' | sort -rn | numfmt --field=1 --to=iec
```

`-printf` 与 `numfmt` 是加分项，说明你处理过"人类可读"的需求。

**答题要点**：先说思路（取列 → 排序 → 计数），再说命令。面试官更看重思路，命令记错一两个参数没关系。

### 第二类：脚本题（能上线才行）

**题 5：写一个脚本，备份指定目录到指定位置，保留最近 7 份**

这类题的核心考点是**错误处理 + 幂等 + 日志**，不是 `tar` 怎么写。

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

SRC="${1:?用法: $0 <源目录> [备份目录]}"
DST="${2:-/backup}"
KEEP=7
STAMP="$(date +%F_%H%M%S)"
NAME="$(basename "$SRC")"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
trap 'log "失败于第 $LINENO 行"; exit 1' ERR

[[ -d "$SRC" ]] || { log "源目录不存在: $SRC"; exit 2; }
mkdir -p "$DST"

log "开始备份 $SRC → $DST/${NAME}_${STAMP}.tar.gz"
tar -czf "$DST/${NAME}_${STAMP}.tar.gz" -C "$(dirname "$SRC")" "$NAME"
log "备份完成，大小 $(du -h "$DST/${NAME}_${STAMP}.tar.gz" | cut -f1)"

# 只保留最近 KEEP 份
mapfile -t old < <(ls -1t "$DST"/"${NAME}"_*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)))
if ((${#old[@]})); then
  log "清理 ${#old[@]} 个旧备份"
  rm -f -- "${old[@]}"
fi
log "完成"
```

四个被考的点：

1. `set -Eeuo pipefail`：失败即停、未定义变量报错、管道错误不吞。
2. `${1:?}`：参数缺失时给用法并退出。
3. `trap ... ERR`：失败时打印行号，排查快十倍。
4. `mapfile` + `tail -n +N`：按时间保留 N 份，比 `find -mtime` 精确。

**题 6：检查一个服务是否存活，不存活就重启并告警**

```bash
#!/usr/bin/env bash
set -euo pipefail

URL="http://127.0.0.1:8080/healthz"
SVC="order-api"
MAX=3

code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$URL" || echo 000)
if [[ "$code" == "200" ]]; then
  echo "ok"
  exit 0
fi

echo "健康检查失败: $code" >&2
for i in $(seq 1 $MAX); do
  systemctl restart "$SVC" && sleep 3
  code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$URL" || echo 000)
  [[ "$code" == "200" ]] && { echo "第 $i 次重启后恢复"; exit 0; }
done

echo "重启 $MAX 次仍未恢复，需要人工介入" >&2
# 告警：curl -X POST webhook ...
exit 1
```

考点：**重试上限**（不要无限重启）、**超时**（`-m 3`）、**告警出口**。

### 第三类：排障题（现场感）

**题 7：服务器磁盘满了，怎么查**

答题顺序（这个顺序本身就是分数）：

```bash
df -h                       # 哪个分区满
df -i                       # 是否是 inode 满
du -sh /* 2>/dev/null | sort -rh | head    # 一级目录定位
lsof +L1                    # 已删除但被占用的文件
journalctl --disk-usage     # 日志占多少
```

关键的一句："如果 `df` 显示满但 `du` 加起来不够，通常是**已删除文件仍被进程占用**，用 `lsof +L1` 找 PID。"

**题 8：CPU 100%，怎么定位**

```bash
top -H -p <pid>             # 定位到线程
printf '%x\n' <tid>         # 线程 id 转 16 进制
jstack <pid> | grep -A20 'nid=0x<hex>'    # Java
# Go：pprof
go tool pprof http://127.0.0.1:6060/debug/pprof/profile?seconds=30
```

**题 9：网站慢，怎么分层定位**

```bash
curl -o /dev/null -s -w 'dns:%{time_namelookup} tcp:%{time_connect} tls:%{time_appconnect} ttfb:%{time_starttransfer}\n' https://x/
```

"哪一段大就查哪一层"——这句话说出来，面试官基本会给分。

### 三个扣分点

1. **不假思索写 `rm -rf $DIR/*`**，没校验变量为空。正确写法：`rm -rf -- "${DIR:?}"/`。
2. **脚本没有 `set -e`**，出错继续往下跑，把一半的状态改坏了。
3. **用 `for f in $(ls)`**，文件名带空格就崩。正确写法：`for f in ./*; do` 或 `find -print0 | xargs -0`。

### 一句话总结

Shell 面试题看的是**工程习惯**：流水线思维、失败处理、变量安全。把这三样表现出来，比背 20 个参数更有说服力。
