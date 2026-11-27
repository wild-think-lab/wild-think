---
title: 文本处理三剑客进阶：grep / sed / awk
module: 进阶篇
summary: 三者的分工与常用套路、日志统计实战、性能与可读性的取舍，五个"命令写出来结果不对"的原因。
minutes: 45
---

### 分工先分清

```
grep：找（行级匹配）
sed：改（流式替换/删除）
awk：算（按列统计/格式化）
```

**"全用 awk 干"** → 可读性差；**"全用 grep 干"** → 做不了聚合。

### grep 常用

```bash
grep -rn "timeout" /etc/nginx/            # 递归 + 行号
grep -c " 500 " access.log                # 计数
grep -oP 'status=\K\d+' access.log | sort | uniq -c
grep -vE "health|/metrics" access.log     # 排除
```

**注意**：

```
① -P 需要 PCRE 支持（部分环境无）
② 大文件用 --mmap 或 fgrep（固定串）
```

### sed 常用

```bash
sed -n '100,120p' file            # 打印区间
sed 's/old/new/g' file
sed -i.bak 's/8080/9090/' app.conf   # 备份后原地改
sed '/^#/d; /^$/d' file           # 去注释与空行
sed -E 's/(\d+)\.(\d+)/[\1:\2]/'  # 分组
```

**`-i` 一定带备份后缀**，尤其在配置上。

### awk 常用

```bash
awk '{sum+=$10} END {print sum}' access.log          # 求和
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head
awk -F, '$3>100 {print $1,$3}' data.csv
awk '{a[$1]++} END {for(k in a) print k, a[k]}' log  # 分组计数
```

### 实战：日志统计四问

**① 谁访问最多**

```bash
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -10
```

**② 哪些接口最慢（假设 $request_time 是第 12 列）**

```bash
awk '$12>1 {print $7, $12}' access.log | sort -k2 -rn | head
```

**③ 5xx 按分钟统计**

```bash
awk '$9>=500 {print substr($4,14,5)}' access.log | sort | uniq -c
```

**④ 每小时的请求量**

```bash
awk '{print substr($4,14,2)":00"}' access.log | sort | uniq -c
```

### 五个"结果不对"

**① 分隔符不对**

```
默认空白，实际是逗号/制表符 → -F 指定
```

**② 行列错位**

```
日志格式中间有引号内的空格 → 字段数不稳定
```

**③ 时区**

```
日志是 UTC，统计按本地理解
```

**④ 排序把数字当字符串**

```
sort 而不是 sort -n → "10" 排在 "9" 前
```

**⑤ 编码/CRLF**

```
Windows 文件带 \r → 匹配失败（dos2unix）
```

### 性能取舍

```
① 大文件先 grep 缩小再 awk
② 避免多次 cat | grep | awk 链
③ 用 LC_ALL=C 加速匹配
```

```bash
LC_ALL=C grep -c "error" big.log
```

### 可读性

```
① 长命令拆成两步（中间落临时文件）
② 复杂 awk 写成 .awk 脚本文件
③ 关键统计加注释（列号含义）
```

### 检查清单

```
□ 分清找/改/算（别混用）
□ sed -i 带备份
□ awk 明确列号含义
□ sort 用 -n 排数字
□ 分隔符/编码已确认
□ 大文件先过滤再聚合
□ 关键命令有注释
□ 结果抽样人工核对
□ 常用套路沉淀成脚本
□ LC_ALL=C 用于加速
```
