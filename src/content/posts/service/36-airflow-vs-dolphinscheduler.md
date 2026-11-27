---
title: Airflow 与 DolphinScheduler：调度平台怎么选
description: 两条主流调度路线的差异不在功能表，而在"谁维护 DAG、怎么补数、失败怎么重跑"。给一份可落地的比较维度。
date: 2026-11-27
tags: [数据工程, 调度, 平台选型]
---

选调度平台的讨论经常变成功能清单对轰：谁支持更多算子、谁的界面更好看。真正的分水岭是三个问题：DAG 由谁写、历史数据怎么补、失败任务怎么重跑。

## 两种基因

```
Airflow：代码即 DAG（Python），工程师文化，DAG 是仓库里的文件
DolphinScheduler：界面即 DAG（可视化拖拽），运维/数据团队文化
```

这不是优劣，是"谁来维护"。

判据：

```
团队以 Python 工程师为主、DAG 需要复杂逻辑与动态生成 → Airflow
团队以数据开发/运维为主、希望业务同学自己配任务 → DolphinScheduler
```

## 架构差异（影响运维成本）

```
Airflow：webserver + scheduler + executor（Local/Celery/K8s）+ 元数据库
         调度状态全在元数据库里，scheduler 是单点（要 HA 得靠外部方案）
DolphinScheduler：api + master + worker + 注册中心（早期依赖 ZooKeeper，新版注册中心可替换）
                  master/worker 天然多副本，故障转移是内建能力
```

**判据**：如果你不想自己解决 scheduler 高可用，DolphinScheduler 的默认形态更省心；如果你已经有成熟的 K8s 平台，Airflow 的 K8sExecutor 更贴合。

## 补数（历史数据重跑）

这是数据平台最高频的操作。

```
Airflow：需要自己设计分区参数（execution_date / data_interval），
         用 backfill 命令或 UI 触发；逻辑要幂等
DolphinScheduler：补数在界面上选时间范围，工作流按依赖补跑
```

**坑**：Airflow 的 backfill 会并发打满资源，要限并发；DolphinScheduler 补数如果任务不幂等，重复写入一样出事。

结论：**两边都必须幂等**，界面只是降低操作门槛。

## 失败重跑与告警

```
Airflow：task 级重试（retries/retry_delay），失败可单任务 clear 重跑
DolphinScheduler：工作流/任务级重跑，支持失败告警（邮件/钉钉/企业微信）
```

判据：需要"只重跑下游"时，两者都能做，但 Airflow 要理解 task 依赖图，DS 更像"从某个节点继续"。

## 资源与多租户

```
Airflow：pool / queue 控制并发，多租户靠 namespace + RBAC（较弱）
DolphinScheduler：租户 + 队列 + worker 分组，多团队隔离更直观
```

**判据**：多个业务团队共用一个平台、需要隔离资源 → DS 更合适。

## 迁移成本

```
Airflow：DAG 是代码，迁移=改连接与依赖，可 review
DolphinScheduler：DAG 在数据库里，迁移靠导出/导入 JSON，diff 困难
```

**这条常被忽略**：可视化 DAG 在生产上改动不可 review，出问题难追溯。折中做法是把 DS 的"工作流定义"也做版本备份。

## 五个选型时常犯的错

**① 只看功能表**：算子数量对实际使用影响很小，补数与重跑才是天天用的

**② 忽略元数据库**：Airflow 的元数据库是核心资产，备份没做好等于平台丢历史

**③ 低估调度延迟**：两者都是"分钟级"调度，秒级需求要用别的（如 K8s CronJob + 队列）

**④ 不考虑 DAG 规模**：几千个 DAG 时，Airflow scheduler 的解析开销要专门优化（DAG 序列化、少用顶层代码）

**⑤ 用调度平台做实时**：两者都不是流处理，实时请用 Flink/Kafka Streams

## 一份落地组合（务实版）

```
批处理调度：Airflow（DAG 进 Git，CR 评审）
业务自助补数：DolphinScheduler（给数据运营用）
实时链路：Flink
监控：两边都接统一告警（不要把告警散在各自平台）
```

这不矛盾：很多团队两个都留，分工明确。

## 检查清单

```
□ 明确"谁写 DAG"（工程师 or 业务）
□ 元数据库有备份与恢复演练
□ DAG/工作流定义进版本管理
□ 任务幂等（补数与重跑的前提）
□ 补数有并发上限
□ 有失败告警（统一入口）
□ 有 SLA 监控（任务是否按时完成）
□ 调度粒度与业务匹配（分钟级）
□ 资源队列/租户隔离已规划
□ 不把实时需求塞进批调度
```
