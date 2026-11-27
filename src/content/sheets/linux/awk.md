---
title: awk 速查
summary: 字段处理、条件过滤、聚合统计、格式化输出与内置变量，一张纸解决日常文本处理。
group: linux
order: 4
tags: [awk, 文本处理, Shell]
---

### 基本结构

```bash
awk 'pattern { action }' file
awk -F: '{print $1}' /etc/passwd
awk 'BEGIN{...} pattern{...} END{...}' file
```

**三段执行**：

```
BEGIN ：读文件前执行一次（初始化、打印表头）
主段  ：每行执行
END   ：读完后执行一次（汇总输出）
```

### 内置变量

| 变量 | 含义 |
| --- | --- |
| `$0` | 整行 |
| `$1..$n` | 第 n 个字段 |
| `$NF` | 最后一个字段 |
| `NF` | 字段数量 |
| `NR` | 当前行号（全局） |
| `FNR` | 当前文件行号 |
| `FS` | 输入分隔符（默认空白） |
| `OFS` | 输出分隔符（默认空格） |
| `RS` | 输入记录分隔符（默认换行） |
| `FILENAME` | 当前文件名 |

### 分隔符

```bash
awk -F: '{print $1}' /etc/passwd      # 冒号
awk -F'\t' '{print $2}' file          # 制表符
awk -F'[ ,]+' '{print $1}' file       # 多个分隔符
awk 'BEGIN{FS=":"; OFS="\t"} {print $1,$2}' file
```

### 条件过滤

```bash
awk '$3 > 100' file                  # 数值比较
awk '$1 == "root"' file              # 字符串相等
awk '/error/' file                   # 正则匹配
awk '!/error/' file                  # 不匹配
awk 'NR>=10 && NR<=20' file          # 行范围
awk '/start/,/end/' file             # 区间
awk 'length($0) > 80' file           # 行长
```

### 统计与聚合

```bash
# 求和
awk '{sum += $3} END{print sum}' file

# 平均
awk '{s+=$3; n++} END{print s/n}' file

# 按 key 分组求和
awk '{sum[$1]+=$2} END{for (k in sum) print k, sum[k]}' file

# 最大值
awk 'NR==1{m=$1} $1>m{m=$1} END{print m}' file

# 去重计数
awk '!seen[$0]++' file              # 去重输出
awk '{c[$1]++} END{for(k in c) print c[k], k}' file

# 行数/字数
awk 'END{print NR}' file
```

**`!seen[$0]++` 是 awk 去重的经典写法**：

```
第一次出现 seen[$0] 为 0（假）→ 取反为真 → 输出
之后为 1（真）→ 取反为假 → 不输出
```

### 格式化输出

```bash
awk '{printf "%-10s %5d\n", $1, $2}' file
awk 'BEGIN{printf "%s\t%s\n", "name", "size"} {printf "%s\t%d\n", $1, $3}' file
```

**常用格式符**：

```
%s  字符串
%d  整数
%f  浮点（%.2f 两位小数）
%-10s 左对齐宽度 10
%5d  右对齐宽度 5
```

### 常用实战

```bash
# 打印某列（比 cut 更灵活）
awk '{print $2}' file

# 交换两列
awk '{print $2, $1}' file

# 加表头
awk 'BEGIN{print "name\tsize"} {print $1"\t"$3}' file

# 统计访问日志状态码分布
awk '{print $9}' access.log | sort | uniq -c | sort -rn

# 统计每个 IP 的请求数 Top 10
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -10

# 按小时统计 QPS
awk -F'[][]' '{print $2}' access.log | cut -d: -f2 | sort | uniq -c

# 累加某列并打印累计值
awk '{s+=$2; print $0, s}' file

# 多文件分别统计（FNR）
awk 'FNR==1{print FILENAME, "start"}' a.txt b.txt

# 关联两个文件（类似 join）
awk 'NR==FNR{a[$1]=$2; next} {print $0, a[$1]}' map.txt data.txt
```

**`NR==FNR` 是"处理第一个文件"的经典技巧**。

### 关联数组与删除

```bash
awk '{a[$1]++} END{for (k in a) if (a[k] > 2) print k}' file
awk '{delete a[$1]}' file
```

**遍历顺序不固定**（哈希），要排序就 `| sort`。

### 字符串函数

```bash
awk '{print length($1)}' file
awk '{print substr($1, 1, 5)}' file
awk '{print toupper($1), tolower($2)}' file
awk '{gsub(/foo/, "bar"); print}' file       # 全局替换
awk '{sub(/foo/, "bar"); print}' file        # 只替换第一个
awk '{print index($0, "error")}' file        # 位置（0 = 未找到）
awk '{n=split($0, arr, ":"); print n, arr[1]}' file
awk '{print $1 ~ /^error/}' file             # 返回 0/1
```

**`gsub` 会修改 `$0`**，这是"就地替换并打印"的常用方式。

### 数字与字符串比较的坑

```bash
# 字符串比较（字典序）
awk '$1 < "10"' file
# 数值比较
awk '$1+0 < 10' file
```

**awk 会自动判断"看起来像数字"**，但 `"010"` 这类有前导零的字符串会比较危险，显式 `+0` 更安全。

### 与 grep/sed 的分工

```
grep：找行（最快）
sed ：改行（替换/删除）
awk ：按字段处理 + 计算（最强）
```

**组合使用例**：

```bash
grep "ERROR" app.log | awk '{print $4}' | sort | uniq -c | sort -rn | head
```

### 坑

```
① -F 与 FS 同时设置时，-F 优先
② 字段索引从 1 开始（$0 是整行）
③ 修改 $n 会重建整行（OFS 生效）
④ 大文件用 awk 比 shell 循环快几十倍
⑤ mawk 与 gawk 有差异（gawk 支持更多扩展，如 asort）
⑥ 遍历数组顺序不确定，要稳定输出必须 sort
```
