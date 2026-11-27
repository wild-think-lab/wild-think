---
title: 条件与循环：让脚本自己判断
module: 入门篇
summary: 文件在不在、服务活没活、值对不对——全用 if 判断；批量处理多台机器、多个文件——全用 for/while。这章给你判断的固定写法。
minutes: 12
---

### if 的固定结构

```bash
if [ "$env" = "prod" ]; then
  echo "生产环境，操作前确认"
elif [ "$env" = "test" ]; then
  echo "测试环境"
else
  echo "未知环境"
  exit 2
fi
```

三个容易踩的格式坑：

1. `[` 后面和 `]` 前面**必须有空格**。`[$x=1]` 会报 `command not found`。
2. 比较字符串用 `=`，数字用 `-eq`；混用会出错。
3. 变量引用一定加引号：`[ "$x" = "a" ]`。不加时，`x` 为空会变成 `[ = a ]`，语法错误。

### 常用判断一览

| 判断 | 含义 |
| --- | --- |
| `[ -f "$f" ]` | 是普通文件 |
| `[ -d "$d" ]` | 是目录 |
| `[ -e "$p" ]` | 存在（文件或目录） |
| `[ -r "$f" ]` | 可读 |
| `[ -w "$f" ]` | 可写 |
| `[ -x "$f" ]` | 可执行 |
| `[ -s "$f" ]` | 文件非空 |
| `[ -z "$s" ]` | 字符串为空 |
| `[ -n "$s" ]` | 字符串非空 |
| `[ "$a" -eq "$b" ]` | 数字相等 |
| `[ "$a" -gt "$b" ]` | 数字大于 |
| `[ "$code" -ne 0 ]` | 退出码非 0（失败） |

### 组合条件

```bash
if [ -f "$conf" ] && [ -w "$conf" ]; then
  echo "可写，继续"
fi

if [ ! -d "$backup_dir" ]; then
  mkdir -p "$backup_dir"
fi
```

要在一个 `[ ]` 里写多个条件，用 `-a/-o` 容易出错，**推荐拆成多个 `[ ]` 用 `&&` 组合**。

### 退出码：脚本之间沟通的方式

```bash
if grep -q "ERROR" /var/log/app.log; then
  echo "发现错误"; exit 1
fi
echo "无错误"; exit 0
```

约定：**0 是成功，非 0 是失败**。写脚本时要保证"失败时返回非 0"，否则上层（CI、定时任务、监控）无法判断。

```bash
#!/usr/bin/env bash
set -euo pipefail
trap 'echo "第 $LINENO 行失败"; exit 1' ERR
```

`trap ... ERR` 能在失败时打印出错行号，排障时省一半时间。

### for 循环

```bash
for h in web01 web02 db01; do
  echo "== $h"
  ssh -o ConnectTimeout=3 "$h" uptime || echo "  $h 不可达"
done
```

遍历文件：

```bash
for f in /var/log/*.log; do
  [ -e "$f" ] || continue        # 没有匹配文件时防止误处理
  echo "$f: $(wc -l < "$f") 行"
done
```

按行读文件（**别用 `for line in $(cat file)`**，会被空格拆开）：

```bash
while IFS= read -r line; do
  echo "处理: $line"
done < hosts.txt
```

`IFS= read -r` 是标准写法：保留反斜杠与行首尾空格。

### while 与重试

```bash
retry=0
until curl -fsS -m 3 http://127.0.0.1:8080/healthz >/dev/null; do
  retry=$((retry + 1))
  [ "$retry" -ge 5 ] && { echo "服务启动失败"; exit 1; }
  echo "等待中（$retry/5）"; sleep 2
done
echo "服务已就绪"
```

这个模式在"启动服务后等它起来"时非常有用，比固定 `sleep 30` 靠谱。

### 数值循环

```bash
for i in $(seq 1 5); do echo "第 $i 次"; done
# 或 bash 原生
for ((i=1; i<=5; i++)); do echo "第 $i 次"; done
```

### 一个实际例子：批量检查磁盘

```bash
#!/usr/bin/env bash
set -euo pipefail

threshold=80
fail=0

while IFS= read -r h; do
  usage=$(ssh -o ConnectTimeout=3 "$h" "df -h / | awk 'NR==2{gsub(\"%\",\"\",\$5);print \$5}'" 2>/dev/null || echo "ERR")
  if [ "$usage" = "ERR" ]; then
    echo "!! $h 连接失败"; fail=1; continue
  fi
  if [ "$usage" -ge "$threshold" ]; then
    echo "!! $h 磁盘 ${usage}%"; fail=1
  else
    echo "ok $h ${usage}%"
  fi
done < hosts.txt

exit "$fail"
```

注意最后的 `exit "$fail"`：有任何一台异常就返回非 0，监控才能报警。

### 本章验证

1. 写一个脚本，判断 `/etc/nginx/nginx.conf` 是否存在且可读，不可读就 `exit 1`。
2. 用 `while read` 遍历三台主机，输出每台的 uptime。
3. 写一个 `until` 重试循环，等 8080 端口起来再继续。

判断与循环是脚本的"决策能力"。写熟这两块，你就可以开始把任何手工流程转成脚本了。
