---
title: jq 实战：把接口返回的 JSON 变成一张能看的表
description: 十个高频表达式、数组与对象的互转、错误容忍与默认值、以及"接口返回几百 KB 但只需要三个字段"的处理方式。
date: 2023-06-30
tags: [jq, 命令行, 工具, JSON]
---

### 先记住三个符号

```
.          当前对象
.[]        展开数组
|          管道（把左边结果给右边）
```

一个最小例子：

```bash
curl -s https://api.example.com/orders | jq '.data[].id'
```

### 十个高频表达式

```bash
# ① 取字段
jq '.data.total'

# ② 展开数组，取某字段
jq '.data.items[].name'

# ③ 构造新对象
jq '.data.items[] | {id: .id, amount: .amount}'

# ④ 条件过滤
jq '.data.items[] | select(.status == "failed")'

# ⑤ 映射转换（数组 → 数组）
jq '[.data.items[] | .id]'

# ⑥ 排序与取前 N
jq '[.data.items[]] | sort_by(.createdAt) | reverse | .[0:5]'

# ⑦ 分组统计
jq '[.data.items[]] | group_by(.status) | map({status: .[0].status, count: length})'

# ⑧ 求和
jq '[.data.items[].amount] | add'

# ⑨ 转 CSV（配 @csv）
jq -r '.data.items[] | [.id, .status, .amount] | @csv'

# ⑩ 缺字段给默认值
jq '.data.items[] | {id: .id, note: (.note // "-")}'
```

### 输出成一张表

```bash
curl -s "$API" | jq -r '
  ["id","status","amount","created"],
  (.data.items[] | [.id, .status, .amount, .createdAt])
  | @tsv' | column -t -s $'\t'
```

产出：

```
id      status   amount  created
o-1001  paid     199.00  2026-11-27T10:00:00Z
o-1002  failed   99.00   2026-11-27T10:05:00Z
```

`@tsv`（制表符）比 `@csv` 更适合终端展示，配 `column -t` 自动对齐。

### 两个最实用的进阶用法

**① `map` 与 `walk`**

```bash
# 把所有字符串值转成大写
jq 'walk(if type == "string" then ascii_upcase else . end)'

# 把数组里每个对象的某个字段改名
jq '.data.items |= map(.name as $n | del(.name) | .title = $n)'
```

**② 递归找某个 key**

```bash
# 在任意层级找所有 "errorMsg"
jq '.. | objects | select(has("errorMsg")) | .errorMsg'
```

`..` 是递归下降，排查嵌套很深的响应时特别有用。

### 接口返回几百 KB，只要三个字段

```bash
curl -s "$API" | jq -c '.data.items[] | {id, status, latency: .metrics.p99}'
```

`-c`（compact）输出单行 JSON，方便后续喂给别的工具或写入文件做流处理。

```bash
# 流式处理大文件，避免一次性读入内存
jq -c '.data.items[]' huge.json | while read -r line; do
  echo "$line" | jq -r '.id'
done
```

### 错误容忍

接口偶尔返回 `null` 或结构不同：

```bash
jq '.data.items[]?.id'            # ? 表示"不存在也不报错"
jq '.data.items // [] | .[].id'   # 默认空数组
jq 'try (.data.items[] | .id) catch "parse-error"'
jq 'if (.data | type) == "array" then .data else [.data] end'
```

`?` 是最常用的容错符：加在可能不存在的字段或数组后面。

### 组合示例：从多个接口拼一张报表

```bash
#!/usr/bin/env bash
set -euo pipefail
api="https://api.example.com"

curl -s "$api/orders" > /tmp/orders.json
curl -s "$api/users"  > /tmp/users.json

jq -n --slurpfile o /tmp/orders.json --slurpfile u /tmp/users.json '
  ($u[0].data | map({key: .id, value: .name}) | from_entries) as $names
  | $o[0].data.items
  | map({order: .id, user: $names[.userId] // "unknown", amount: .amount})
  | sort_by(-.amount)
  | .[0:10]
'
```

`from_entries` 把 `[{key,value}]` 变成对象，是"用 ID 关联两张表"的标准做法。

### 与 JMESPath / yq 的区别

| 工具 | 适合 |
| --- | --- |
| jq | JSON 任意变换，最灵活 |
| JMESPath | 云 CLI 的查询语法（`--query`） |
| yq | YAML（语法接近 jq） |

K8s 场景：

```bash
kubectl get pod -o json | jq -r '
  .items[] | select(.status.phase != "Running")
  | [.metadata.name, .status.phase] | @tsv'
```

这条比 `grep` 靠谱得多——`kubectl get` 的表格输出会被截断，JSON 不会。

### 五个常见坑

1. **忘了 `-r`**：默认输出带引号的 JSON 字符串，`"o-1001"` 而不是 `o-1001`。
2. **`.[]` 用在对象上**：对象遍历 values；要 key 用 `keys`。
3. **数字精度**：jq 用双精度浮点，超过 2^53 的 ID 会丢精度，提前当字符串处理。
4. **中文编码**：默认转义非 ASCII，加 `-r` 或 `-a`。
5. **大文件内存**：几百 MB 的 JSON 用 `--stream`，否则吃满内存。

```bash
jq --stream 'select(length==2) | .[1]' huge.json | head
```

### 一句总结

jq 的价值不在"能查字段"，而在**把接口返回直接变成人能读的表或下游能吃的结构**。会 `select / map / group_by / @tsv / from_entries` 这五个，日常就够了。
