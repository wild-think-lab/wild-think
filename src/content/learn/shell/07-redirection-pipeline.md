---
title: 重定向与管道：让命令能组合起来
module: 熟练篇
summary: 三个文件描述符、七种重定向写法、管道与退出码（含 pipefail），以及五个"输出丢了"的原因。
minutes: 35
---

### 三个文件描述符

```
0  stdin   标准输入
1  stdout  标准输出（数据）
2  stderr  标准错误（日志/错误）
```

**关键区分**：

```
数据走 stdout，日志走 stderr
→ 才能"管道拿数据，屏幕看日志"
```

### 七种常用写法

```bash
cmd > out.txt             # stdout 覆盖
cmd >> out.txt            # stdout 追加
cmd 2> err.txt            # stderr 到文件
cmd > all.log 2>&1        # 两个都到 all.log
cmd &> all.log            # bash 简写（等价）
cmd 2>/dev/null           # 丢掉 stderr
cmd > /dev/null 2>&1 &    # 完全静默后台
```

**"2>&1 > file"** 顺序错了 → stderr 仍打屏幕（顺序有语义）。

### 管道

```bash
ps aux | grep nginx | grep -v grep
cat access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head
```

**"cat 一个文件再管道"** 多数情况可省（`awk '{...}' file` 直接读）。

### 退出码

```bash
cmd; echo $?         # 上一条的返回码
```

**管道默认只看最后一条**：

```bash
set -o pipefail
false | true; echo $?    # 开 pipefail 后为 1
```

**"中间那步失败了但脚本继续"** → 必须开 pipefail。

### tee：既看又存

```bash
cmd 2>&1 | tee -a run.log
```

**"只 > 文件"** → 当时看不到进度；tee 兼顾。

### 五个"输出丢了"

**① 缓冲**

```
程序输出被重定向到文件时是"块缓冲" → 看起来卡住/为空
（用 stdbuf -oL，或程序内 flush）
```

**② 日志本来到 stderr**

```
只重定向 stdout → 错误看不到
```

**③ 管道中间进程失败**

```
没开 pipefail → 退出码为 0
```

**④ 子 shell 变量丢失**

```
ls | while read x; do cnt=$((cnt+1)); done; echo $cnt  # 0
（管道的 while 在子 shell 里）
```

**解决**：

```bash
while read -r x; do cnt=$((cnt+1)); done < <(ls)
echo "$cnt"
```

**⑤ 权限**

```
重定向到无权限目录 → "Permission denied"（但命令本身没错）
```

### 一个"能排障"的脚本头部

```bash
#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >&2; }
trap 'log "ERROR at line $LINENO rc=$?"' ERR
```

**`-x` 调试**：

```bash
bash -x script.sh
# 或在脚本里 set -x（只对某段开）
```

### 检查清单

```
□ 数据走 stdout，日志走 stderr
□ 重定向顺序正确（> file 2>&1）
□ 脚本开头 set -Eeuo pipefail
□ 用 tee 保留现场
□ 管道读变量用 < <(…) 避免子 shell
□ 知道缓冲导致的"看起来没输出"
□ 有 trap 打印出错行
□ 有 log 函数（带时间戳，走 stderr）
```
