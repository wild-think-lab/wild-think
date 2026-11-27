---
title: 脚本是什么：从第一行 shebang 开始
module: 入门篇
summary: 把"手敲命令"变成"文件里的命令"。这章要你写出第一个能跑、能改、能重复跑的脚本，并知道它为什么需要第一行。
minutes: 10
---

### 一句话定义

**脚本就是一份命令清单，交给 Shell 一条条执行。**

手敲命令的问题不是慢，是**不可重复**：昨天敲对了，今天漏了一步，结果就不一样。脚本把"对的顺序"固定下来。

### 第一个脚本

```bash
mkdir -p ~/lab/sh && cd ~/lab/sh
cat > hello.sh <<'EOF'
#!/usr/bin/env bash
echo "hello from $(hostname)"
EOF
chmod +x hello.sh
./hello.sh
```

三行代码，三个必须理解的点。

### 第一行到底干什么

`#!/usr/bin/env bash` 叫 shebang。它告诉系统：**用哪个程序来解释这个文件**。

- 写在文件里而不是靠 `bash hello.sh` 调用，是为了让别人（和定时任务）不需要知道你用的是 bash 还是 sh。
- `/usr/bin/env bash` 比 `/bin/bash` 更稳：它会去 PATH 里找 bash，换发行版也不会断。

没有 shebang 的脚本，`./script` 执行时会落到默认 shell（常常是 `sh`），于是你写的 `[[ ]]`、`function` 全部报错。

### 为什么需要 chmod +x

Linux 里"能不能执行"是一个权限位，不是扩展名。没有 `x` 位就会出现 `Permission denied`。

```bash
ls -l hello.sh        # -rwxr-xr-x 才有执行权
chmod +x hello.sh     # 给自己和执行组加执行
```

### 执行脚本的两种方式，差别很大

| 方式 | 是否新开进程 | 变量/环境变化是否影响当前 shell |
| --- | --- | --- |
| `./hello.sh` | 是（子进程） | 不影响 |
| `source hello.sh` / `. hello.sh` | 否（当前 shell 执行） | 影响 |

初学者最常见的困惑："我在脚本里 `cd /tmp`，为什么回到命令行还在原目录？"——因为你用了 `./` 执行，它跑在子进程里。

### 让脚本更像个工具

```bash
#!/usr/bin/env bash
set -euo pipefail

main() {
  echo "host: $(hostname)"
  echo "user: $(whoami)"
  echo "date: $(date '+%F %T')"
}

main "$@"
```

`set -euo pipefail` 是三个开关：

- `-e`：任何命令失败就退出（不然会带着错误继续跑）。
- `-u`：用到未定义变量就报错（防拼写错误）。
- `-o pipefail`：管道里任一环失败算失败。

**没有这三行的脚本，出问题时表现是"跑完了但结果是错的"**——这是最糟的失败方式。

### 本章验证

1. 写出 `hello.sh`，用 `./hello.sh` 和 `bash hello.sh` 都跑通。
2. 在脚本里加 `cd /tmp`，分别用 `./` 和 `source` 执行，观察 `pwd` 的差别。
3. 故意把 `echo` 写成 `echoo`，看 `set -e` 下脚本是否立即退出。

做到这三条，你已经跨过了"写脚本"的门槛——剩下的都是语法。
