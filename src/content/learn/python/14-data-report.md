---
title: 数据处理与报表：pandas 的实用姿势
module: 熟练篇
summary: 读大文件的分块、常用清洗动作、分组聚合、导出与调度，五个"pandas 一跑就 OOM"的原因。
minutes: 50
---

### 读取要带参数

```python
import pandas as pd

df = pd.read_csv("big.csv",
                 usecols=["id", "ts", "amount"],   # 只读需要的列
                 dtype={"id": "int64", "amount": "float64"},
                 parse_dates=["ts"])
```

**判据**：默认读全表 + object 类型 → 内存翻几倍。

### 分块处理（超内存）

```python
chunks = pd.read_csv("huge.csv", chunksize=200_000)
total = 0
for c in chunks:
    total += c["amount"].sum()
```

**"一次 read 几千万行"** → OOM。

### 常用清洗

```python
df = df.dropna(subset=["id"])                 # 关键字段去空
df["amount"] = df["amount"].fillna(0)
df["ts"] = pd.to_datetime(df["ts"], errors="coerce")
df = df[df["amount"] >= 0]                    # 过滤异常
df["month"] = df["ts"].dt.to_period("M")
```

**要点**：

```
① errors="coerce" 让脏数据变 NaT（而不是抛错）
② 先过滤再计算（减少无效行）
```

### 分组聚合

```python
g = (df.groupby(["month", "channel"], as_index=False)
       .agg(orders=("id", "count"),
            amount=("amount", "sum"),
            users=("user_id", "nunique")))
```

**注意**：

```
① nunique 比 count 慢（去重代价）
② as_index=False 让结果好导出
```

### 窗口与排名

```python
df = df.sort_values(["user_id", "ts"])
df["prev_ts"] = df.groupby("user_id")["ts"].shift(1)
df["gap_days"] = (df["ts"] - df["prev_ts"]).dt.days
```

### 导出

```python
g.to_csv("report.csv", index=False, encoding="utf-8-sig")   # Excel 友好
g.to_excel("report.xlsx", index=False)                       # 行数少时用
```

**`utf-8-sig`** 避免 Excel 打开中文乱码。

### 五个"pandas 一跑就 OOM"

**① 读全表**

```
几百万行 × 几十列 object
```

**② 中间结果太多**

```
每步都生成新 df，旧的不释放
```

```python
del tmp; gc.collect()
```

**③ object 类型**

```
字符串列占大量内存 → 用 category
```

```python
df["channel"] = df["channel"].astype("category")
```

**④ apply 逐行**

```
比向量化慢 10-100 倍
```

```python
# 慢
df["x"] = df.apply(lambda r: r.a * 2, axis=1)
# 快
df["x"] = df["a"] * 2
```

**⑤ 一次性 concat 很多小表**

```
循环 concat → O(n²)
```

```python
df = pd.concat(list_of_dfs, ignore_index=True)   # 一次
```

### 调度（让它每天跑）

```
① cron / systemd timer
② Airflow / DolphinScheduler（有依赖与重试）
```

```ini
# systemd timer 片段
[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true
```

### 检查清单

```
□ 读取指定列与 dtype
□ 大文件分块
□ 关键字段校验（空/类型/范围）
□ 中间结果及时释放
□ 用 category 压缩字符串
□ 用向量化替代 apply
□ concat 一次完成
□ 导出编码 Excel 友好
□ 有调度与失败告警
□ 有数据量/耗时基线
```
