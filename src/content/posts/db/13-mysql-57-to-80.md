---
title: MySQL 5.7 升 8.0：哪些东西会坏
description: 排序规则、认证插件、保留字、GROUP BY 隐式排序、JSON 行为变化，以及可灰度的升级步骤与回滚方案。
date: 2023-10-24
tags: [MySQL, 升级, 兼容性, 数据库]
---

### 升级前必须知道的六个变化

**① 默认字符集与排序规则**

```
5.7：utf8（其实是 utf8mb3）+ utf8_general_ci
8.0：utf8mb4 + utf8mb4_0900_ai_ci
```

影响：

- 老表的 `utf8_general_ci` 与新表的 `utf8mb4_0900_ai_ci` 排序结果可能不同（如 `a` 与 `A`、中文排序）。
- **跨表 JOIN 时排序规则不一致会报错**：

```
Illegal mix of collations for operation 'join'
```

处理：

```sql
-- 升级前统一
ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
-- 或保留旧规则
SET default_collation_for_utf8mb4 = utf8mb4_general_ci;
```

**② 默认认证插件**

```
5.7：mysql_native_password
8.0：caching_sha2_password
```

影响：老客户端（老版本 PHP/Java 驱动、Navicat 老版本）**连不上**，报 `Authentication plugin 'caching_sha2_password' cannot be loaded`。

处理：

```sql
-- 单用户降回旧插件
ALTER USER 'app'@'%' IDENTIFIED WITH mysql_native_password BY 'xxx';

-- 或全局默认
[mysqld]
default_authentication_plugin = mysql_native_password
```

**③ 保留字**

8.0 新增保留字：`RANK`、`ROW`、`GROUPS`、`LEAD`、`LAG`、`CUBE` 等。

影响：如果表名/字段名叫 `rank`、`row`，**不加反引号的 SQL 会语法错误**。

扫描：

```bash
grep -rniE '\b(rank|row|groups|lead|lag|cube|over|window)\b' app/sql/ | head
```

处理：加反引号，或改名。

**④ GROUP BY 不再隐式排序**

```
5.7：GROUP BY 会隐式 ORDER BY（依赖这个行为的代码会出问题）
8.0：不保证顺序
```

处理：显式写 `ORDER BY`。

**⑤ JSON 与正则**

- `JSON` 函数行为有调整（如 `JSON_EXTRACT` 返回类型）。
- 正则引擎从 Henry Spencer 换成 ICU，**正则语法与行为不同**（大小写、Unicode 类）。

**⑥ 不再支持的功能**

| 移除 | 替代 |
| --- | --- |
| `Query Cache` | 应用层缓存 / Redis |
| `innodb_file_format` | 已固定 |
| `PROCEDURE ANALYSE` | 自行统计 |
| 部分 `sql_mode` 组合 | 用新的组合 |

### 升级前检查

**① 兼容性扫描（官方工具）**

```bash
mysqlsh --uri root@localhost:3306 -- util check-for-upgrade
```

输出会列出：不兼容的排序规则、保留字冲突、已废弃参数。

**② 参数体检**

```bash
mysqld --verbose --help > /tmp/8.0-defaults.txt
diff <(grep -E '^[a-z_]+' /etc/mysql/my.cnf | sort) ...
```

主要检查：已废弃的参数（如 `innodb_large_prefix`、`innodb_file_format`）**存在会导致 8.0 启动失败**。

**③ 表结构与数据量**

```sql
SELECT table_schema, COUNT(*), SUM(data_length)/1024/1024 AS mb
FROM information_schema.tables GROUP BY table_schema;
```

大表升级耗时主要在"字典升级"（8.0 会重建数据字典）。

### 升级步骤（可灰度）

```
① 备份（mysqldump + xtrabackup 双保险）
② 预发环境升级 + 跑全量业务测试
③ 生产：从库先升（5.7 主 → 8.0 从，官方支持这种组合）
④ 观察到从库稳定（1–3 天）
⑤ 主从切换（把 8.0 提升为主）
⑥ 旧主降级为从或下线
```

**关键点**：5.7 主 → 8.0 从 是官方支持的复制组合，可以"先升从库"降低风险。

切换：

```bash
# 主库设为只读，等从库追平
mysql -e "SET GLOBAL super_read_only=ON;"
# 确认 Seconds_Behind_Master=0 且 GTID 一致
# 提升从库
mysql -e "SELECT * FROM performance_schema.replication_group_members;"   # 视架构而定
mysql -e "STOP SLAVE; RESET SLAVE ALL;"
mysql -e "SET GLOBAL super_read_only=OFF;"
```

### 回滚方案

```
① 镜像/快照回滚（最快，5 分钟内）
② 备份恢复（30 分钟–数小时，取决于数据量）
③ 主从切回（前提是旧主还在且未写入新数据）
```

**升级当天不要做数据变更（DDL）**，否则回滚后数据结构不一致。

### 升级后要验的六项

```sql
-- 1. 版本与字符集
SELECT VERSION(); SHOW VARIABLES LIKE 'character_set_server';

-- 2. 认证插件（老客户端能否连）
SELECT user, plugin FROM mysql.user;

-- 3. 排序规则一致性（是否还有 utf8_general_ci 混用）
SELECT table_schema, table_name, table_collation
FROM information_schema.tables
WHERE table_collation LIKE '%general_ci';

-- 4. 保留字冲突（启动日志里有无语法错误）
-- 5. 慢查询是否变化
-- 6. 复制状态
SHOW SLAVE STATUS\G
```

### 一个真实的坑

升级后业务报错：

```
Illegal mix of collations (utf8mb4_general_ci,IMPLICIT) and (utf8mb4_0900_ai_ci,IMPLICIT) for operation '='
```

原因：老表是 `utf8mb4_general_ci`，新加的表是 8.0 默认 `utf8mb4_0900_ai_ci`，JOIN 时报错。

修复（不改数据）：

```sql
-- 连接级临时统一
SET collation_connection = utf8mb4_general_ci;
```

根治：把全库统一到同一排序规则（需要重建表，安排窗口）。

### 检查清单

```
□ mysqlsh check-for-upgrade 无高危项
□ 废弃参数已删除（否则起不来）
□ 保留字冲突已扫描
□ 排序规则已统一或已设默认
□ 老客户端的认证插件兼容性验证过
□ 备份 + 快照双保险
□ 先升从库，观察后再切主
□ 升级当天不做 DDL
```
