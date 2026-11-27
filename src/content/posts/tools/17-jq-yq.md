---
title: jq 与 yq：把 JSON/YAML 当数据库查
description: 十个真正高频的 jq 表达式、yq 的对应写法，以及五个"写了很长却查不出结果"的原因。
date: 2025-02-19
tags: [工具, jq, yq]
---

### 为什么必须会

```
kubectl get -o json / API 响应 / CI 配置 / 日志
→ 99% 的场景都要"从结构化数据里取一个字段"
```

### 十个高频 jq

```bash
# 1) 取字段
jq '.name'

# 2) 取数组元素
jq '.items[0]'

# 3) 遍历（每个元素取一个字段）
jq '.items[].metadata.name'

# 4) 过滤
jq '.items[] | select(.status == "Running")'

# 5) 映射成新对象
jq '.items[] | {name: .metadata.name, ns: .metadata.namespace}'

# 6) 计数
jq '.items | length'

# 7) 按字段分组计数
jq '[.items[].status] | group_by(.) | map({status: .[0], count: length})'

# 8) 排序取前 N
jq '[.items[] | {n: .metadata.name, t: .age}] | sort_by(.t) | .[0:3]'

# 9) 默认值
jq '.spec.replicas // 1'

# 10) 拼接字符串
jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name)"'
```

**`-r`（raw）** 让输出不带引号（给 shell 用必加）。

### 常用组合（实战）

```bash
# 找 Pod 重启次数最多的
kubectl get pods -A -o json | jq -r '
  .items[] | "\(.restartCount // 0)\t\(.metadata.namespace)/\(.metadata.name)"' \
  | sort -rn | head -5

# 找出没有 limits 的容器
kubectl get pods -A -o json | jq -r '
  .items[] | select(.spec.containers[] | .resources.limits == null)
  | "\(.metadata.namespace)/\(.metadata.name)"'

# 镜像列表去重
kubectl get pods -A -o json | jq -r '.items[].spec.containers[].image' | sort -u
```

**"用 jq 替代一堆 grep/awk"** 是提效的关键。

### 常用过滤器

```
map(f)        ：对数组每个元素应用
select(cond)  ：过滤
group_by(f)   ：分组
sort_by(f)    ：排序
unique        ：去重
to_entries    ：对象转 [{key,value}]
with_entries  ：批量改 key/value
flatten       ：拍平
add           ：求和/合并
length        ：长度
has(k)        ：是否有键
```

### yq（YAML 版）

```bash
yq '.spec.template.spec.containers[0].image' deploy.yaml
yq '.spec.replicas = 3' -i deploy.yaml
yq '.metadata.labels.team = "core"' -i deploy.yaml
yq -o json deploy.yaml            # YAML → JSON
yq -P -o yaml config.json        # JSON → YAML
```

**"改 Deployment 副本数"** 用 yq 比 sed 安全得多。

### 五个"写了很长却查不出结果"的原因

**① 结构猜错（多了一层）**

```
kubectl get pods 是 PodList → .items
kubectl get pod x -o json 是单个对象 → 没有 .items
```

**先看结构**：

```bash
jq 'keys' file.json
jq '.items[0] | keys'
```

**② 字段名带短横线**

```
.metadata.labels."app.kubernetes.io/name"
```

**③ null 与不存在**

```
`.a.b` 在 .a 不存在时报错 → 用 `.a?.b`
```

**④ 类型不对**

```
数字被当字符串（"3"）→ 比较失败
→ 用 `tonumber`
```

**⑤ select 条件写错**

```
select(.status=="running") 但实际是 "Running"
→ 大小写敏感
```

### 一个"看结构"的习惯

```bash
# 先看顶层
jq 'keys'
# 再看数组元素结构
jq '.items[0] | keys'
# 再取一个样本
jq '.items[0]'
```

**"盲写表达式"是最慢的方式**。

### 检查清单

```
□ 会用 -r 输出裸字符串
□ 会用 .[] 遍历
□ 会用 select 过滤
□ 会用 map/group_by 做统计
□ 会用 // 给默认值
□ 先 keys 看结构再写表达式
□ yq 改 YAML（不用 sed）
□ 会用 yq -o json 转换
□ 记得 ?. 与 tonumber
```
