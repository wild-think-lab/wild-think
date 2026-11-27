---
title: 第一批命令：看、找、改
module: 入门篇
summary: 12 条命令覆盖 80% 的日常操作，配一个 15 分钟练习和 5 个最容易踩的坑。
minutes: 20
---

### 别看，先动手

下面这 12 条命令，是日常操作的绝大部分。学命令最好的方式不是背，是**在练习目录里乱搞一遍**。

### 看：现在是什么情况

```bash
ls -lh          # 列表：-l 详细，-h 文件大小换单位
cat file        # 一次全打出来（短文件用）
head -20 f      # 前 20 行
tail -f app.log # 实时跟着看日志，Ctrl+C 退出（排错神器）
less file       # 分页看，q 退出（长文件用这个）
```

`tail -f` 是排错第一命令：改完配置重启服务，一边看日志一边操作，报错立刻出现。

### 找：东西在哪

```bash
find /etc -name "*.conf"          # 按名字找文件
grep -rn "关键词" /etc            # 在文件内容里搜，-r 递归，-n 显示行号
grep -i "error" app.log           # 忽略大小写
which nginx                       # 这个命令在哪
```

`find` 找**文件名**，`grep` 搜**文件内容**，这两个别混。搜日志里的报错用 `grep`，找"到底有几个配置文件"用 `find`。

### 改：创建、复制、移动、删除

```bash
mkdir -p /opt/app/logs   # -p 连同父目录一起建
cp -r dir1 dir2          # -r 复制目录
mv a b                   # 移动；同一目录里就是改名
rm file                  # 删文件，删了不进回收站，没有后悔药
```

严肃建议：给 `rm` 加个别名，删之前先确认。

```bash
alias rm='rm -i'   # 每次删前问一句，写进 ~/.bashrc 才永久生效
```

### 15 分钟练习

```bash
mkdir -p ~/lab && cd ~/lab
echo "hello linux" > a.txt
cp a.txt b.txt
echo "second line" >> b.txt        # >> 是追加，> 是覆盖
head -1 b.txt
grep -n "linux" *.txt
mv b.txt c.txt
ls -lh
rm c.txt
```

这十行里藏着两个关键区别，务必分清：

| 符号 | 作用 | 写错会怎样 |
| --- | --- | --- |
| `>` | 覆盖写入 | 用 `>` 去追加，原内容全丢 |
| `>>` | 追加写入 | 用 `>>` 去写配置，旧配置还在，变成两份 |

### 五个最容易踩的坑

1. **`>` 当 `>>` 用**：把配置覆盖成一行，服务起不来。
2. **路径没写 `./`**：`./start.sh` 写成 `start.sh`，提示 command not found。
3. **`rm -rf` 不加确认**：`rm -rf /tmp/*` 少个空格就变成 `rm -rf / tmp/*`，前者删临时文件，后者删根目录。
4. **copy 忘了 `-r`**：目录直接报 `omitting directory`。
5. **在错误目录执行**：`pwd` 先看一眼，比事后找文件便宜得多。

### 本章小结

- 看：`ls` `cat` `head` `tail -f` `less`
- 找：`find` 找文件、`grep` 找内容
- 改：`mkdir -p` `cp -r` `mv` `rm`
- `>` 覆盖、`>>` 追加，记反了就是事故。

**下一章**：为什么你总是被 `Permission denied` 拦住。
