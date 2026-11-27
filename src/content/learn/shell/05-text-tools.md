---
title: 文本三件套：grep、awk、sed 够用版
module: 熟练篇
summary: 只学工作中真正用到的部分：怎么从日志里捞出关键行、怎么取某一列、怎么批量替换。附五个可直接套用的命令。
minutes: 13
---

### 三个工具的分工

| 工具 | 干什么 | 一句话记法 |
| --- | --- | --- |
| grep | 按正则**找行** | 过滤 |
| awk | 按分隔符**取列、算数** | 取值与统计 |
| sed | 按规则**改文本** | 替换 |

三者串起来就是最经典的运维操作：**找到 → 取出 → 改写**。

### grep：先学会"限定范围"

```bash
grep -i error /var/log/app.log            # 忽略大小写
grep -n "timeout" app.log                 # 带行号
grep -c "ERROR" app.log                   # 只数条数
grep -v "healthz" access.log              # 排除健康检查
grep -r "password" /etc/nginx/            # 递归目录
grep -E "ERROR|FATAL" app.log             # 扩展正则（或 egrep）
grep -A3 -B1 "Exception" app.log          # 前后各带几行
```

日志排查最常用的一条：

```bash
grep -E "ERROR|FATAL" app.log | tail -20
```

**限定时间范围**用 `awk` 更合适，但简单场景可以：

```bash
awk '$0 >= "2026-11-27 10:00" && $0 <= "2026-11-27 11:00"' app.log
```

### awk：按列取值与统计

```bash
awk '{print $1, $7}' access.log           # 第 1 列和第 7 列
awk -F: '{print $1}' /etc/passwd          # 指定分隔符为冒号
awk 'NR==2{print $5}'                     # 只处理第 2 行
awk 'END{print NR}' app.log               # 总行数
```

累加与分组统计（最实用的用法）：

```bash
# 按状态码统计请求数，倒序
awk '{print $9}' access.log | sort | uniq -c | sort -rn | head

# 求和：总响应字节
awk '{sum += $10} END{printf "%.1f MB\n", sum/1024/1024}' access.log

# 按小时统计错误条数
grep ERROR app.log | awk -F'[: ]' '{print $2}' | sort | uniq -c
```

条件判断：

```bash
awk '$9 >= 500 {print $7, $9}' access.log | head
awk '/ERROR/ && $4 > 1000 {print}' app.log
```

### sed：替换与删除

```bash
sed -n '10,20p' file           # 打印 10–20 行
sed 's/old/new/' file          # 每行第一处替换
sed 's/old/new/g' file         # 每行全部替换
sed '/^#/d' file               # 删除注释行
sed '/^$/d' file               # 删除空行
```

**原地修改必须加 `-i`**，并建议先备份：

```bash
sed -i.bak 's/8080/9090/g' config.yml
```

Mac 上的 `sed -i` 需要参数，跨平台脚本用 `perl -pi -e` 更统一：

```bash
perl -pi -e 's/8080/9090/g' config.yml
```

### 五个可直接套用的命令

**1. 找访问量最高的 IP**

```bash
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -10
```

**2. 找 5xx 最多的 URL**

```bash
awk '$9 ~ /^5/ {print $7}' access.log | sort | uniq -c | sort -rn | head
```

**3. 从日志里切出时间与级别**

```bash
sed -nE 's/^([0-9-]+ [0-9:]+) ([A-Z]+) (.*)$/\1 \2/p' app.log | head
```

**4. 批量改配置文件里的域名**

```bash
grep -rl "old.example.com" /etc/nginx/ | xargs sed -i 's/old.example.com/new.example.com/g'
```

**5. 统计某接口 P95 耗时（简易）**

```bash
awk '$7=="/api/order" {print $NF}' access.log | sort -n | awk '{a[NR]=$1} END{print a[int(NR*0.95)] " ms"}'
```

### 三个常见坑

1. **`grep` 命中二进制文件**：加 `-I` 跳过二进制，否则输出一堆乱码。
2. **正则贪婪**：`.*` 会吃掉整行，取中间内容用 `[^"]*` 之类的限定写法。
3. **`sed` 的特殊字符**：替换内容里有 `/` 时换分隔符，`sed 's|/a/b|/c/d|g'`。

### 本章验证

1. 从一份 nginx access.log 里找出 5xx 最多的 3 个 URL。
2. 用 `awk` 统计某个时间段的请求总数。
3. 用 `sed -i.bak` 批量替换一个配置项，并用 `diff` 确认只改了目标行。

这三个工具不需要学全。**把"取列、统计、替换"练熟，就足够处理 90% 的日志与配置工作。**
