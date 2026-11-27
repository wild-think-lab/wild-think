---
title: 文本处理三剑客：grep / sed / awk 的实战用法
description: 三个工具各自的定位、高频参数、日志统计的十个真实例子、性能差别，以及什么时候该换 Python。
date: 2026-11-27
tags: [Shell, awk, sed, grep, 文本处理]
---

### 三者的分工

- **grep**：按行筛选。找"哪些行符合条件"。
- **sed**：按行替换与编辑。改"某几行的内容"。
- **awk**：按列处理与统计。算"每列的和、平均值、分组计数"。

一条经验：**先 grep 缩小范围，再 awk 算，最后 sort/uniq 统计**。这个流水线能解决 90% 的日志分析。

### grep：不只是查找

```bash
grep -i error app.log              # 忽略大小写
grep -v healthz access.log         # 排除
grep -c ' 500 ' access.log         # 计数
grep -r --include='*.conf' 'Timeout' /etc/   # 递归 + 限定文件
grep -n 'panic' app.log            # 带行号
grep -A3 -B3 'panic' app.log       # 上下文各 3 行
grep -E 'ERROR|FATAL' app.log      # 扩展正则
grep -oP 'rt=[0-9.]+' access.log | head   # -o 只输出匹配部分（配合 -P 支持 \d）
grep -l 'pattern' *.log            # 只列文件名
grep -L 'pattern' *.log            # 列出不匹配的文件
```

高频组合：

```bash
# 统计某接口的调用次数
grep -c 'GET /api/v1/orders' access.log

# 排除健康检查后再看 5xx
grep ' 5' access.log | grep -v healthz | head -20

# 找带指定 traceId 的所有行
grep 'a1b2c3d4' *.log
```

### sed：改文本

```bash
sed -n '10,20p' file.txt                # 只打印 10–20 行
sed -i.bak 's/old/new/g' file.txt       # 原地替换 + 备份
sed -i 's#/old/path#/new/path#g' file   # 路径替换用 # 分隔更安全
sed '/^#/d' config.ini                  # 删掉注释行
sed '/^$/d' file                        # 删空行
sed 's/  */ /g' file                    # 压缩多余空格
sed -e 's/a/b/' -e 's/c/d/' file        # 多条件
sed '/start/,/end/d' file               # 删除区间
sed '2i\新的一行' file                   # 第 2 行前插入
sed '$a\末尾追加' file
```

注意：

- macOS 的 `sed -i` 需要额外参数（`-i ''`），Linux 不需要。
- `sed` 不支持非贪婪匹配，复杂正则要用 `perl -pe` 或 awk。
- `-i` 不做备份时，改错就没了，**默认加 `.bak`**。

### awk：算列

```bash
awk '{print $1, $3}' file              # 打印第 1、3 列
awk -F: '{print $1}' /etc/passwd        # 指定分隔符
awk -F'"' '{print $2}' access.log      # 按引号切，提取请求行
awk 'NR>1' file                        # 跳过第一行（表头）
awk '$3 > 100 {print $1}' file          # 条件过滤
awk '{sum+=$5} END {print sum}' file    # 求和
awk '{sum+=$5; n++} END {print sum/n}' file   # 平均
awk '!seen[$1]++' file                  # 按第一列去重（保留首次出现）
awk '{a[$1]+=$2} END {for (k in a) print k, a[k]}' file   # 分组求和
```

### 十个真实场景

**① 按 IP 统计访问量 Top 10**

```bash
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -10
```

**② 统计每个接口的 P50/P99 耗时**

Nginx 日志里有 `urt=` 时：

```bash
awk -F'urt=' '{split($2,a,","); print a[1]}' access.log \
| sort -n | awk '{v[NR]=$1} END {print "P50="v[int(NR*0.5)], "P99="v[int(NR*0.99)]}'
```

**③ 找出访问量异常的时间段（按分钟）**

```bash
awk -F'[' '{split($2, t, ":"); print t[1]":"t[2]}' access.log | sort | uniq -c | sort -rn | head
```

**④ 统计状态码分布**

```bash
awk '{print $9}' access.log | sort | uniq -c | sort -rn
```

**⑤ 提取所有 traceId 并按数量排序**

```bash
grep -oP 'rid=\K[a-f0-9]+' access.log | sort | uniq -c | sort -rn | head
```

**⑥ 找出最慢的 10 个请求（含 URL）**

```bash
awk -F'rt=' '{split($2,a," "); print a[1], $0}' access.log | sort -rn | head -10 | cut -c1-160
```

**⑦ 日志按小时聚合错误数**

```bash
grep ' ERROR ' app.log | awk '{print substr($2,1,2)}' | sort | uniq -c
```

**⑧ 批量重命名文件**

```bash
for f in *.jpeg; do mv "$f" "${f%.jpeg}.jpg"; done
```

**⑨ 提取 JSON 里的字段（没有 jq 时）**

```bash
grep -oP '"user_id":\s*\K\d+' resp.json | sort -u
```

**⑩ 从配置里删掉某类行**

```bash
sed -i.bak '/^Listen 80$/d' /etc/httpd/conf/httpd.conf
```

### 性能：大文件怎么处理

- `grep` 很快（几 GB/s 级别），优先用它缩小范围，再做 awk。
- `awk` 比 `sed` 更适合"计算"，`sort` 是瓶颈（要外部排序，占磁盘）。
- 处理 10GB 以上日志，先 `split` 或直接上 `ripgrep`（`rg`，多线程，快 5–10 倍）：

```bash
rg 'ERROR' -n --no-heading app.log | head
rg -c ' 500 ' access.log
```

### 什么时候该换 Python

出现这三种情况，awk 就不合适了：

1. 需要 JSON 嵌套解析（用 `jq` 或 Python）。
2. 需要按时间窗口聚合（awk 手写时间解析太痛苦）。
3. 需要多文件关联（join 两次以上）。

```python
import json, sys
for line in sys.stdin:
    rec = json.loads(line)
    if rec["status"] >= 500:
        print(rec["path"], rec["duration_ms"])
```

### 一句话总结

`grep` 筛行、`awk` 算列、`sed` 改内容，`sort | uniq -c` 做统计。这四个拼起来就是一台"日志分析机"，比打开 Excel 快得多。
