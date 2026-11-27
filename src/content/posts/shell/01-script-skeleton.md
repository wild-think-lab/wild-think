---
title: 第一个能上线的 Shell 脚本：从 shebang 到 set -euo pipefail
description: 大部分“运维脚本”死在错误处理和变量引用上。这篇给你一个安全骨架，以后所有脚本从它开始。
date: 2021-11-24
tags: [Shell, 脚本, 自动化, 入门]
---

### 脚本是什么

把一串命令写进文件，让系统按顺序执行。仅此而已——它的价值不在"高级"，在**可重复、可交付、可定时**。

```bash
#!/usr/bin/env bash
# 第一行是 shebang：告诉系统用哪个解释器执行这个文件
echo "hello"
```

执行前必须有执行权限：`chmod +x hello.sh && ./hello.sh`。

### 安全骨架：三行开头决定脚本质量

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
```

逐条解释：

| 写法 | 作用 | 不写的后果 |
| --- | --- | --- |
| `set -e` | 任何命令失败立刻退出 | 前面已失败，后面继续跑，改坏数据 |
| `set -u` | 使用未定义变量时报错 | 空变量被当成空字符串，`rm -rf /$DIR/` 变 `rm -rf //` |
| `set -o pipefail` | 管道中任一环失败即失败 | 用 grep 过滤时，前一步失败被 grep 的成功掩盖 |
| `IFS=$'\n\t'` | 改分词分隔符 | 文件名带空格时被拆成两个参数 |

这不是"进阶技巧"，是**底线**。没有这三行的脚本，在生产上只是一个定时炸弹。

### 变量与引用

```bash
NAME="web01"                 # 等号两侧不能有空格
echo "host: ${NAME}"         # 花括号明确边界
path="/var/log/${NAME}.log"
echo "${#NAME}"              # 长度
echo "${NAME:-default}"      # 为空则用默认值
```

引用规则：

- **永远加双引号**：`"$VAR"`。不加引号时，空格和通配符会被 Shell 再解释一次。
- 需要字面量时用单引号：`echo '$HOME'` 输出 `$HOME`。

### 参数处理

```bash
usage() {
  echo "用法: $0 -d 目标目录 [-n 数量]" >&2
  exit 2
}

target=""
num=10

while getopts "d:n:h" opt; do
  case "$opt" in
    d) target="$OPTARG" ;;
    n) num="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

[ -z "$target" ] && usage
echo "target=$target num=$num"
```

`exit 2` 表示用法错误，方便上层判断；报错信息走 `>&2`（stderr），别混进正常输出。

### 退出码与判断

```bash
if command -v nginx >/dev/null 2>&1; then
  echo "nginx 已安装"
else
  echo "未安装" >&2
fi

curl -sf http://localhost/health || { echo "健康检查失败" >&2; exit 1; }
```

`$?` 是上一条命令的退出码，0 为成功。**别用输出内容判断成败，用退出码**。

### 一个完整的备份脚本

```bash
#!/usr/bin/env bash
set -euo pipefail

SRC="/var/www/html"
DST="/backup/www"
STAMP="$(date +%Y%m%d-%H%M)"

mkdir -p "$DST"
tar -czf "${DST}/html-${STAMP}.tar.gz" -C "$(dirname "$SRC")" "$(basename "$SRC")"

# 只保留最近 7 份
ls -1t "${DST}"/html-*.tar.gz | tail -n +8 | xargs -r rm -f

echo "[$(date '+%F %T')] backup ok: ${DST}/html-${STAMP}.tar.gz"
```

三个细节值得注意：`f` 后缀防止空变量、`xargs -r` 在没有输入时不执行、时间戳让每份备份可追溯。

### 本章要点

- `set -euo pipefail` 是最低标准，不是可选项。
- 变量一律加双引号；`${VAR:-default}` 给默认值。
- 用退出码判断成败，报错走 stderr。
- 备份类脚本要能"只留最近 N 份"，否则磁盘迟早满。
