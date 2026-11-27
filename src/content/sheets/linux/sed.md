---
title: sed 速查
summary: 替换、删除、插入、按行范围操作与原地修改，一张纸覆盖 90% 日常用法。
group: linux
order: 3
tags: [sed, 文本处理, Shell]
---

### 基本语法

```bash
sed [选项] '脚本' 文件
sed [选项] -e '脚本1' -e '脚本2' 文件
sed [选项] -f script.sed 文件
```

### 常用选项

| 选项 | 含义 |
| --- | --- |
| `-n` | 不自动打印（配合 `p` 使用） |
| `-i` | 原地修改（GNU）；macOS 用 `-i ''` |
| `-i.bak` | 原地修改并留备份 |
| `-E` / `-r` | 扩展正则 |
| `-e` | 多脚本 |
| `-f` | 从文件读脚本 |

### 替换（最高频）

```bash
sed 's/foo/bar/' f            # 每行第一个
sed 's/foo/bar/g' f           # 全部
sed 's/foo/bar/2' f           # 每行第 2 个
sed -i 's/foo/bar/g' f        # 原地
sed -i.bak 's/foo/bar/g' f    # 原地 + 备份
```

**分隔符可换**（路径里有 `/` 时非常有用）：

```bash
sed 's#/usr/local#/opt#g' f
sed 's|a|b|g' f
```

### 正则相关

```bash
# 扩展正则（不用转义 + ? | ( )）
sed -E 's/(a|b)+/x/g' f

# 分组引用
sed -E 's/(\w+)@(\w+)/\2 at \1/' f

# 大小写（GNU）
sed 's/foo/\U&/g' f        # 转大写
sed 's/foo/\L&/g' f        # 转小写
```

**`&` 代表整个匹配**：

```bash
sed 's/foo/[&]/g' f        # foo → [foo]
```

### 删除行

```bash
sed '1d' f              # 第 1 行
sed '$d' f              # 最后一行
sed '1,5d' f            # 1–5 行
sed '5,$d' f            # 5 到最后
sed '/pattern/d' f      # 匹配的行
sed '/^$/d' f           # 空行
sed '/^\s*#/d' f        # 注释行
sed '/a/,/b/d' f        # a 到 b 之间
```

### 打印（配合 `-n`）

```bash
sed -n '5p' f           # 第 5 行
sed -n '3,7p' f         # 3–7 行
sed -n '/start/,/end/p' f   # 一段
sed -n '$p' f           # 最后一行
sed -n '/foo/p' f       # 匹配行（等价 grep）
```

### 插入与追加

```bash
sed '3i\new line' f     # 第 3 行前插入
sed '3a\new line' f     # 第 3 行后追加
sed '1i\#!/bin/bash' f  # 文件头插 shebang
sed '/pattern/a\after it' f
```

**GNU sed 可以省略反斜杠**：

```bash
sed '1i #!/bin/bash' f
```

### 行号与地址

```bash
sed '2,4s/foo/bar/' f          # 只在 2–4 行替换
sed '/start/,/end/s/foo/bar/g' f  # 只在区间内替换
sed '1~2d' f                   # 删除奇数行（GNU）
sed '0~2d' f                   # 删除偶数行（GNU）
```

### 多行处理（N / D / P）

```bash
# 把下一行拼到当前行（处理跨行模式）
sed 'N;s/\n/ /' f

# 删除最后一行的换行（合并最后两行）
sed -z 's/\n$//' f
```

### 常用实战

```bash
# 去 Windows 换行
sed -i 's/\r$//' f
# 或
dos2unix f

# 去行首行尾空格
sed 's/^[[:space:]]*//; s/[[:space:]]*$//' f

# 给每行加前缀
sed 's/^/PREFIX /' f

# 行尾加后缀
sed 's/$/ SUFFIX/' f

# 提取配置文件的值
sed -n 's/^port *= *\([0-9]*\).*/\1/p' app.conf

# 注释掉匹配行
sed '/^server /s/^/#/' nginx.conf

# 取消注释
sed '/^#server /s/^#//' nginx.conf

# 把多行合成一行（用逗号）
sed ':a;N;$!ba;s/\n/,/g' f

# 只输出不匹配的行（等价 grep -v）
sed -n '/pattern/!p' f
```

### 与 awk/grep 的选择

```
grep ：找行
sed  ：改行（替换/删除/插入）
awk  ：处理字段与计算
```

**单行替换用 sed，字段计算用 awk，两者经常串起来用**：

```bash
kubectl get pods | awk 'NR>1 {print $1}' | sed 's/-[a-z0-9]*$//' | sort -u
```

### 坑

```
① macOS 的 sed 是 BSD 版，-i 必须带参数：sed -i '' 's/a/b/' f
② -i 与 -E 顺序：GNU 支持 sed -Ei，BSD 要分开写
③ 替换内容含 & 要转义：sed 's/a/\&/'
④ 替换内容含 / 要换分隔符或用 \/
⑤ 大文件用 sed -i 会写临时文件（磁盘空间要够）
⑥ -n 与 p 必须成对，否则输出重复或全无
```
