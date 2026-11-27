---
title: 库表设计与数据类型：一开始就别挖坑
module: 入门篇
summary: 建表时最容易犯的五个错：字符串用 varchar(255)、金额用 float、时间用字符串、主键用业务字段、索引乱加。逐个讲清怎么选。
minutes: 12
---

### 建表就是定契约

表结构一旦有数据，改动成本会越来越高。所以在第一版就把类型选对，比后来加索引省事得多。

```sql
CREATE TABLE orders (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_no      CHAR(20)        NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  amount        DECIMAL(12,2)   NOT NULL,
  status        TINYINT         NOT NULL DEFAULT 0,
  remark        VARCHAR(200)    NOT NULL DEFAULT '',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_order_no (order_no),
  KEY idx_user_created (user_id, created_at)
) ENGINE=InnoDB;
```

### 五个必须记住的类型选择

**1. 主键：`BIGINT UNSIGNED AUTO_INCREMENT`**

- 不要用业务字段（订单号、身份证）当主键：业务字段会变、会泄露信息、长度大。
- 不要用 UUID 当聚簇索引主键：随机写入会让 B+ 树频繁分裂，写性能掉一半。
- 自增 ID 的代价是"能被枚举"，对外用单独的 `order_no` 暴露。

**2. 金额：`DECIMAL`，绝不用 `FLOAT/DOUBLE`**

```sql
amount DECIMAL(12,2)      -- 精确到分，最大 10 位整数
```

浮点数存 0.1 就是 0.100000000000000005，对账会对不上。

**3. 时间：`DATETIME` 或 `TIMESTAMP`，不要 `VARCHAR`**

| 类型 | 范围 | 时区 |
| --- | --- | --- |
| `DATETIME` | 1000–9999 | 不带时区，存什么读什么 |
| `TIMESTAMP` | 1970–2038 | 按 UTC 存储，受 `time_zone` 影响 |
| `VARCHAR(19)` | 任意 | 无法比较、无法索引高效 |

`DATETIME(3)` 带毫秒，适合有并发写入的场景（排序更稳）。

**4. 状态：`TINYINT` + 注释，不要存中文**

```sql
status TINYINT NOT NULL DEFAULT 0 COMMENT '0待支付 1已支付 2已取消 3已完成'
```

存 `"已支付"` 会导致：索引变大、改文案要改数据、无法做数值比较。

**5. 字符串：按实际长度定，不要一律 255**

```sql
name    VARCHAR(50)
phone   CHAR(11)
code    CHAR(8)
```

- `VARCHAR(n)` 是变长，长度上限只影响校验，不占满空间。
- 定长且长度固定的用 `CHAR`（如手机号、省份编码）。
- 超长文本用 `TEXT`，但它不能做索引（除非前缀索引），且和大字段分开表存更好。

### 索引不是越多越好

```sql
KEY idx_user_created (user_id, created_at)
```

三条原则：

1. **联合索引最左前缀**：`(user_id, created_at)` 能服务 `WHERE user_id=?`，不能服务 `WHERE created_at=?`。
2. **区分度高的列在前**：状态只有 4 个值，放前面没意义。
3. **每个索引都增加写入成本**：一张表 5 个以上索引就要审视。

唯一索引的特殊价值：**它是并发下的最后一道防线**。靠"先查再插"防重复，在并发下必失效。

### 三个常见坏设计

| 坏设计 | 问题 | 改法 |
| --- | --- | --- |
| 一张表 60 列 | 行太大，缓存命中率低 | 拆主表 + 扩展表 |
| 用逗号存多值（`tags: "a,b,c"`） | 无法索引、无法查询 | 拆关联表或 JSON 列 |
| 全部字段 `NOT NULL DEFAULT ''` | 分不清"没填"和"空字符串" | 允许 NULL 表达"未知"，但索引与比较要小心 |

关于 NULL：`NULL` 参与比较结果都是 `UNKNOWN`，`WHERE col != 'x'` 会漏掉 NULL 行。**能避免就避免，必须用就明确写 `IS NULL`**。

### 命名与注释

- 表名小写下划线：`order_items`，不要 `OrderItems`（大小写在 Linux 上敏感）。
- 每个字段加 `COMMENT`，半年后你会感谢自己。
- 时间字段统一 `created_at` / `updated_at`，别一半 `create_time` 一半 `ctime`。

### 本章验证

1. 建一张你有真实需求的表，写出字段类型与理由。
2. 给这张表设计 2 个索引，说明每个索引服务哪条查询。
3. 故意把金额存成 `FLOAT`，插入 `0.1` 与 `0.2`，看求和结果是否等于 `0.3`。

类型选错是最贵的错误——它不会立刻报错，而是在半年后让一次对账、一次迁移变得极难。
