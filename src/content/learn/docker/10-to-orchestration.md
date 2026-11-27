---
title: 从单机到编排：Compose 之后往哪走
module: 进阶篇
summary: 单机上限、迁移到 K8s 的判定、Compose 与 K8s 的映射表、以及五个"上了编排反而更乱"的原因。
minutes: 40
---

### 单机能撑到哪

```
Compose 适合：
① 单机部署、无多副本需求
② 流量可预期（一台够用）
③ 团队小、运维简单
```

**判据（该考虑编排）**：

```
① 需要多副本/滚动发布
② 需要跨机器扩缩
③ 需要自愈（节点级）
④ 多环境一致性要求高
```

**"为了 K8s 而 K8s"** 是最常见的过度工程。

### 映射表

| Compose | Kubernetes |
| --- | --- |
| service | Deployment / StatefulSet |
| ports | Service / Ingress |
| environment | ConfigMap / Secret |
| volumes | PV / PVC |
| depends_on | initContainer / 探针 |
| restart: always | restartPolicy（由控制器管） |
| healthcheck | liveness/readinessProbe |
| deploy.replicas | replicas |
| networks | NetworkPolicy |

### 迁移的最小步骤

```
① 镜像先规范（非 root、只读、探针）
② 配置外置（ConfigMap/Secret）
③ 有状态服务单独处理（StatefulSet + PVC）
④ 入口换成 Ingress
⑤ 上线前做一次"滚动 + 回滚"演练
```

**"直接 apply 一堆 YAML"** 会卡在存储与入口两处。

### 有状态服务的现实

```
数据库上 K8s 不是不行，但要额外解决：
① 卷的性能与可用性（本地盘 vs 网络盘）
② 主从/集群的拓扑（Operator 或手工）
③ 备份（Velero + 逻辑备份）
④ 升级（不能随便滚动）
```

**建议**：小规模用"虚拟机/裸机 + K8s 引用外部服务"，别把数据库塞进集群。

### 五个"上了编排反而更乱"

**① 没有资源 request**

```
调度乱、OOM、互相抢
```

**② 镜像太大**

```
拉镜像慢 → 扩容/漂移都慢
```

**③ 配置靠改镜像**

```
每次改配置都要重新构建 → 无法快速回滚
```

**④ 没有日志/监控**

```
出问题只能 kubectl describe
```

**⑤ 权限全给 cluster-admin**

```
一次误操作影响全集群
```

### 一个"渐进"的路径

```
阶段 1：Compose 单机（现在）
阶段 2：多机 + 反向代理 + 手工部署
阶段 3：K8s 仅承载无状态服务
阶段 4：有状态服务用 Operator（如需要）
```

**"一步到位"** 往往在第 2 步就卡住。

### 检查清单

```
□ 明确"为什么"要编排
□ 镜像已规范化（非 root/探针/小）
□ 配置外置
□ 有状态服务有独立方案
□ 有 Ingress 与证书方案
□ 有日志/监控接入
□ 有资源 request/limit
□ 有滚动与回滚演练
□ 权限按 namespace 最小化
□ 有"回退到 Compose"的预案
```
