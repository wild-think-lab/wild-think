---
title: awk / sed / grep：日志分析的三件套
description: 三个工具的分工、十二条能直接用的组合、以及"为什么 awk 比写 Python 快"的实际场景。
date: 2024-06-24
tags: [Shell, awk, sed, grep, 日志]
---

### 三者分工

```
grep  按行筛选（有什么）
sed   按行替换/删除/插入（改成什么）
awk   按字段处理与统计（算什么）
```

**记忆法**：**筛选 -> 改写 -> 汇总**。

### grep 的六个用法

```bash
grep -n "error" app.log              # 带行号
grep -v "debug" app.log              # 排除
grep -i "timeout" app.log            # 忽略大小写
grep -c "error" app.log              # 计数
grep -E "error|fatal" app.log        # 扩展正则（多个词）
grep -A3 -B1 "exceptions" app.log    # 前后各几行（看上下文）
grep -r "TODO" src/                  # 递归目录
```

**最实用的组合**：

```bash
# 排除噪音再统计
grep -v -E "healthcheck|favicon" access.log | grep -c " 500 "
```

### sed 的六个用法

```bash
sed -n '10,20p' file              # 打印 10–20 行
sed 's/old/new/' file             # 替换每行第一处
sed 's/old/new/g' file            # 替换每行所有
sed 's/old/new/g' -i file         # 原地修改（-i 前先备份：-i.bak）
sed '/^#/d' file                  # 删除注释行
sed '1,5d' file                   # 删除前 5 行
```

**"按行号取范围"是看日志最常用的**：

```bash
sed -n '/2026-11-27 10:05/,/2026-11-27 10:10/p' app.log
```

**注意**：`sed` 是"流编辑"，处理大文件时比 `vim` 快，但**不适合做复杂逻辑**。

### awk 的七个能力

**基本结构**：

```
awk 'BEGIN{初始化} 模式{动作} END{收尾}'
```

```bash
# 1. 取第 N 列
awk '{print $1, $7}' access.log

# 2. 按分隔符
awk -F',' '{print $2}' data.csv

# 3. 条件过滤
awk '$9 == 500' access.log

# 4. 求和
awk '{sum += $10} END {print sum}' access.log

# 5. 分组统计（最有用）
awk '{count[$9]++} END {for (c in count) print c, count[c]}' access.log

# 6. 去重
awk '!seen[$1]++' file

# 7. 格式化输出
awk '{printf "%-20s %8d\n", $1, $2}' file
```

### 十二条实战组合

**① 统计状态码分布**

```bash
awk '{print $9}' access.log | sort | uniq -c | sort -rn
```

或者一步到位：

```bash
awk '{c[$9]++} END {for (k in c) print c[k], k}' access.log | sort -rn
```

**② 找访问量最大的 10 个 IP**

```bash
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head
```

**③ 统计每秒请求数（QPS 曲线）**

```bash
# 假设 access.log 的第 4 列是时间 [27/Nov/2026:10:05:01
awk -F'[:[]' '{c[$3":"$4":"$5]++} END {for (t in c) print t, c[t]}' access.log | sort
```

**④ 找出最慢的 20 个请求**

```bash
# 假设 $request_time 是最后一列
awk '{print $NF, $7}' access.log | sort -rn | head -20
```

**⑤ 按小时统计 5xx**

```bash
grep " 5[0-9][0-9] " access.log | awk -F'[:[]' '{c[$3":"$4]++} END {for (t in c) print t, c[t]}' | sort
```

**⑥ 提取所有不重复的接口路径**

```bash
awk '{print $7}' access.log | sed 's/?.*//' | sort -u
```

**⑦ 日志里找某次请求的全链路**

```bash
grep "rid=abc123" *.log | awk '{print $4, $0}'
```

**⑧ 统计每个接口的 P99（近似）**

```bash
# 简单做法：排序后取第 99% 位置的耗时
awk '{print $7, $NF}' access.log | sort -k2 -n | awk '{a[NR]=$2; p[$1]=NR} END {print a[int(NR*0.99)]}'
```

**（真正的分位数建议用工具，如 `goaccess`）**

**⑨ 从 JSON 日志里提字段**

```bash
# 有 jq 时用 jq（推荐）
jq -r 'select(.level=="error") | .msg' app.log

# 没有 jq 时用 grep + sed（脆弱，仅应急）
grep '"level":"error"' app.log | sed 's/.*"msg":"\([^"]*\)".*/\1/'
```

**⑩ 找重复的错误消息**

```bash
grep -i error app.log | sed 's/[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}/DATE/g' | sort | uniq -c | sort -rn | head
```

**关键技巧：先把变化的部分（时间/ID/IP）替换成占位符，再统计**。

**⑪ 批量改名**

```bash
for f in *.log; do mv "$f" "${f%.log}.log.bak"; done
```

**⑫ 大文件按时间切分**

```bash
awk '/2026-11-27 10:00/,/2026-11-27 11:00/' app.log > window.log
```

### awk 为什么比 Python 快

```
① 单进程、无解释器启动开销（Python 启动就要 50ms+）
② 对"逐行处理"高度优化
③ 不需要加载数据结构（流式处理内存恒定）
```

**但**：

```
awk 的字符串/日期处理弱
复杂逻辑（JSON、时间解析、多文件关联）用 Python 更省事
```

**判断**：

```
"过滤 / 取列 / 求和 / 计数" → awk
"解析结构 / 跨文件关联 / 调接口" → Python
```

### 性能提示

```bash
# 大文件先过滤再处理（管道是流式的，不会全读进内存）
zcat access.log.gz | awk '{c[$9]++} END{...}'

# 避免 sort 全量（先过滤缩小）
# LC_ALL=C 让 sort/awk 更快（不用处理多语言排序）
LC_ALL=C sort file
```

### 三个常见坑

```
① sed -i 不备份 → 改错了没法回
   用 sed -i.bak

② awk 的 $0 是整行，$1 是第一列（不是第 0 列）
   忘记这点会导致"少一列"的错

③ grep 的正则默认是 BRE（需转义 + ? {}）
   用 grep -E 才是扩展正则（更符合直觉）
```

### 检查清单

```
□ 筛选用 grep（-v 排除噪音）
□ 改动用 sed（-i 前先 .bak）
□ 统计用 awk（分组计数最常用）
□ 先替换变化部分再统计（时间/ID 换占位符）
□ 大文件用流式管道（不落中间文件）
□ 复杂逻辑换 Python（不硬用 awk）
□ 正则明确 BRE/ERE（grep 用 -E）
```
