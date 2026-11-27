---
title: 变量与参数：脚本怎么接收外部输入
module: 入门篇
summary: 变量、引号、环境变量、位置参数、默认值——把"写死"的脚本变成能带参数运行的工具。
minutes: 12
---

### 变量的基本规则

```bash
name="web01"
port=8080
path="/var/log/app"

echo "$name $port $path"      # 引用要加 $
```

三条硬规则：

1. **等号两边不能有空格**。`name = "web01"` 会被当作命令 `name` 执行，报 `command not found`。
2. **赋值不加 `$`，引用才加 `$`**。
3. **引用时加引号**。`"$path"` 能防路径里有空格导致的参数错位。

### 单引号与双引号的区别

```bash
x=world
echo "hello $x"     # hello world   —— 双引号会展开变量
echo 'hello $x'     # hello $x      —— 单引号原样输出
echo "today $(date +%F)"
```

记法：**双引号"会解释"，单引号"死板"**。写 SQL、正则、JSON 时优先单引号。

### 环境变量与 export

```bash
export APP_ENV=prod
env | grep APP_ENV
```

- 普通变量只在本脚本有效。
- `export` 后子进程（包括脚本里调用的其他命令）也能读到。
- 脚本读环境变量的标准写法：

```bash
: "${APP_ENV:=dev}"        # 没设就赋默认值
echo "env=$APP_ENV"
```

`${VAR:=default}` 比 `if [ -z "$VAR" ]` 简洁得多。

### 位置参数：`$1`、`$@`、`$#`

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "脚本名: $0"
echo "参数个数: $#"
echo "全部参数: $@"
echo "第一个: ${1:-（未提供）}"
```

| 写法 | 含义 |
| --- | --- |
| `$0` | 脚本自身路径 |
| `$1`…`$9` | 第 1..9 个参数 |
| `${10}` | 第 10 个参数（必须加花括号） |
| `$#` | 参数个数 |
| `$@` | 全部参数，加引号后每个参数独立 |
| `$*` | 全部参数拼成一个字符串 |

**`"$@"` 一定要带引号**，否则带空格的参数会被拆开。

### 参数解析：别自己数 $1 $2

```bash
usage() { echo "用法: $0 -e <env> [-n dry-run]"; }

env=""
dry="no"
while getopts ":e:n" opt; do
  case $opt in
    e) env=$OPTARG ;;
    n) dry=yes ;;
    :) echo "选项 -$OPTARG 需要参数"; exit 2 ;;
    *) usage; exit 2 ;;
  esac
done

[ -z "$env" ] && { usage; exit 2; }
echo "env=$env dry=$dry"
```

`getopts` 的好处是**别人用你的脚本时不用读源码**：`-h` 就是帮助，`-e prod` 就是环境。

### 数组与遍历（bash 4+）

```bash
hosts=(web01 web02 db01)
for h in "${hosts[@]}"; do
  echo "check $h"
done
echo "共 ${#hosts[@]} 台"
```

`"${hosts[@]}"` 同样必须加引号。

### 命令替换与算术

```bash
now=$(date +%F)
files=$(ls /var/log | wc -l)
count=$((files + 1))
```

- `$(...)` 比反引号 `` ` `` 好：可嵌套、可读。
- 算术用 `$(( ))`，不要用 `expr`。

### 一个完整的例子

```bash
#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${LOG_DIR:-/var/log/myapp}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DRY="${DRY:-no}"

if [ ! -d "$LOG_DIR" ]; then
  echo "目录不存在: $LOG_DIR" >&2
  exit 1
fi

cmd=(find "$LOG_DIR" -name '*.log' -mtime +"$KEEP_DAYS" -print)
if [ "$DRY" = "yes" ]; then
  echo "[dry-run] 将删除："
  "${cmd[@]}"
else
  "${cmd[@]}" -delete
fi
```

注意 `"${cmd[@]}"` 的用法：把命令拼成数组再执行，比字符串拼 `eval` 安全得多。

### 本章验证

1. 写一个脚本，要求 `-e` 传环境、不传就报错退出。
2. 用 `${VAR:-default}` 让同一个脚本在没设环境变量时也能跑。
3. 故意传一个带空格的参数（`"a b"`），对比 `$@` 和 `"$@"` 的差别。

变量与参数这一章的全部意义是：**脚本不该只有作者本人会用。**
