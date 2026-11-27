---
title: 脚本性能与并发：别让脚本拖垮机器
module: 进阶篇
summary: 减少子进程、批量处理、并行执行与限流、进度与中断处理，五个"脚本一跑机器就卡"的原因。
minutes: 45
---

### 先知道瓶颈在哪

```
① 子进程开销（每次 $(...) 都 fork）
② 逐行处理（while read 里调命令）
③ 串行 IO（一个个下载/拷贝）
④ 无限制并发（一次起 500 个 curl）
```

**判据**：脚本 CPU 不高但很慢 → 多半在等 IO 或 fork。

### 减少子进程

```bash
# 慢：每行都调用外部命令
while read -r line; do
  echo "$line" | awk '{print $2}'
done < file

# 快：一次处理
awk '{print $2}' file
```

```bash
# 慢
n=$(cat file | wc -l)
# 快
n=$(wc -l < file)
```

### 批量而不是逐个

```bash
# 慢：每个文件一次 rsync
for f in *.log; do rsync "$f" host:/data/; done

# 快：一次
rsync -a *.log host:/data/
```

**同理**：`mysql` 用一条多值 INSERT，而不是循环 1000 次。

### 并行与限流

```bash
# xargs 并行（-P 并发数）
printf '%s\n' "${urls[@]}" | xargs -n1 -P8 -I{} curl -fsS -o /dev/null {}

# GNU parallel
parallel -j 8 "curl -fsS -o /dev/null {}" ::: "${urls[@]}"
```

**注意**：

```
① 并发数 = 核数 × 2（IO 密集）或更小
② 目标服务能不能承受（别把自己打成 DDoS）
③ 需要输出有序时用 --keep-order
```

### 后台任务与等待

```bash
pids=()
for f in *.tar; do
  tar -xf "$f" -C out &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
```

**"直接 & 不等"** → 脚本退出后任务被中断（或留下孤儿）。

### 进度与中断

```bash
trap 'echo "interrupted at $n"; exit 130' INT TERM
```

```bash
# 简单进度
total=$(wc -l < list); n=0
while read -r x; do
  n=$((n+1))
  (( n % 100 == 0 )) && echo "$n/$total"
done < list
```

**"跑了半小时不知道到哪"** → 无法判断要不要等。

### 五个"一跑机器就卡"

**① 无限并发**

```
for 里直接 & 起几千个进程 → fork 风暴
```

**② 无节制内存**

```
把所有行读进数组（几百万行）
```

**③ 死循环重试**

```
没有次数上限与退避
```

**④ IO 打满**

```
多个大文件同时拷到同一块盘
```

**⑤ 日志刷屏**

```
每行都 echo → IO 与磁盘都满
```

### 大文件处理姿势

```bash
# 流式处理，不整体读入
awk 'NR%1000==0 {print NR}' huge.log
# 分片
split -l 100000 huge.log part_
```

### 检查清单

```
□ 先定位瓶颈（fork/IO/CPU）
□ 用批量命令替代循环
□ 并行有并发上限
□ 后台任务有 wait
□ 有 trap 处理中断
□ 有进度输出
□ 重试有上限与退避
□ 大文件流式处理
□ 日志不过度打印
□ 关键脚本有执行时间记录
```
