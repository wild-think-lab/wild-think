---
title: 高可用架构：主从切换与组复制
module: 进阶篇
summary: 主从复制做读扩展、MHA/orchestrator 做切换、组复制（MGR）共识写入，五个"高可用实际不可用"的原因。
minutes: 50
---

### 先分清两件事

```
① 读扩展：一主多从（复制延迟是常态）
② 高可用：主挂能自动切（数据不能丢太多）
```

**"有从库就等于高可用"** → 主挂了没人切，从库只是备份。

### 复制基础

```sql
-- 主库
CREATE USER 'repl'@'10.0.0.%' IDENTIFIED BY '<pwd>';
GRANT REPLICATION SLAVE ON *.* TO 'repl'@'10.0.0.%';
SHOW BINARY LOG STATUS;   -- 记录 file/pos

-- 从库
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST='10.0.0.10', SOURCE_USER='repl',
  SOURCE_PASSWORD='<pwd>', SOURCE_AUTO_POSITION=1;
START REPLICA;
```

```sql
SHOW REPLICA STATUS\G
-- 关键字段：Replica_IO_Running / Replica_SQL_Running / Seconds_Behind_Source
```

**异步复制**：主库崩溃可能丢最后一段（未传到的 binlog）。

### 半同步与组复制

```
① 半同步（semi-sync）：至少一个从库确认才返回
② 组复制（MGR）：多数派共识，单主或多主
```

```sql
-- MGR 关键参数
group_replication_group_name = "9d1c...uuid"
group_replication_start_on_boot = OFF
group_replication_local_address = "10.0.0.10:33061"
group_replication_group_seeds = "10.0.0.10:33061,10.0.0.11:33061,10.0.0.12:33061"
group_replication_single_primary_mode = ON
```

**代价**：MGR 写入要求多数派在线（3 节点容忍 1 台挂）；网络抖动会阻塞写入。

### 切换工具

```
MHA / orchestrator / 云厂商托管
```

**切换要看**：

```
① 数据丢失窗口（异步 = 可能丢）
② 应用连接串（VIP / DNS / 代理）
③ 旧主恢复后是否自动回归（可能脑裂）
```

### 应用侧必须配合

```
① 连接串指向 VIP/域名（不是某个 IP）
② 有重试（切库瞬间会报错）
③ 只读流量可路由到从库（但要容忍延迟）
④ 写后立即读要走主库（避免读到旧数据）
```

**"连接串写死主库 IP"** → 切换后要改配置重启。

### 五个"高可用实际不可用"

**① 从库延迟大**

```
Seconds_Behind_Source 几百秒 → 切换会丢更多
```

**② 只有 2 节点 MGR**

```
挂一台就没有多数派（永不切换）
```

**③ VIP 漂移没测**

```
故障时 VIP 没跟过来
```

**④ 切换后没清旧主**

```
旧主恢复后双主写入 → 数据冲突
```

**⑤ 没有演练**

```
真出事时没人敢点"切换"
```

### 一次演练清单

```
① 主库断电（模拟）
② 观察切换耗时（目标 < 30s）
③ 应用错误率与恢复时间
④ 数据一致性核对（行数/关键表）
⑤ 旧主恢复后的处理（重做从库）
```

### 检查清单

```
□ 复制状态与延迟有监控
□ 有自动/半自动切换工具
□ 连接串走 VIP/DNS
□ 应用有重试与超时
□ 写后读走主库
□ MGR 至少 3 节点
□ 切换后旧主被隔离/重建
□ 有脑裂防护
□ 每季度演练一次
□ 有数据核对流程
```
