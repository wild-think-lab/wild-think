---
title: 第 2 章：发布与不中断
module: 入门篇
summary: 滚动策略与 PDB、优雅退出的三件事、双版本兼容与"发布成功但用户报错"的断点。
minutes: 40
---

### 一次"不中断"发布的四个前提

```
① 服务能"新旧版本共存"（接口与数据兼容）
② 有多个副本（单副本必然中断）
③ 探针能反映真实可用
④ 有回滚路径且演练过
```

**"只有 1 个副本"** → 任何滚动都会中断。

### 滚动策略

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0        # 不减少可用副本
    maxSurge: 25%            # 先扩再缩
terminationGracePeriodSeconds: 30
```

**`maxUnavailable: 0` + `maxSurge`** 是"零中断"的标准写法。

### 优雅退出的三件事

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh","-c","sleep 5 && kill -TERM 1"]
```

```
① 从 Service 摘流量（kube-proxy/Ingress 更新有延迟，所以 sleep）
② 处理完在途请求（应用收到 SIGTERM 后 graceful shutdown）
③ 超时才强杀（terminationGracePeriodSeconds）
```

**"没 preStop"** → 摘流量与进程退出同时发生，必然有一些 502。

### 双版本兼容（最重要）

```
接口：新版本新增字段，不删旧字段（删要两阶段）
数据：新表/新列先"双写"再切换，最后清理
消息：消费者要能处理"旧格式 + 新格式"
```

**"发布时改了字段名"** → 灰度期间新旧 Pod 互相不兼容。

### PDB（滚动时保护容量）

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: {name: app-pdb}
spec:
  minAvailable: 2
  selector: {matchLabels: {app: myapp}}
```

**"drain 时被拒绝"** → PDB 在保护你（说明副本不够再腾一台）。

### 发布流程（可落地）

```
1) 构建镜像（打 digest）
2) 预发环境验证
3) 灰度 1 个副本 → 观察 5 分钟
4) 灰度 25% → 观察 15 分钟
5) 全量
6) 观察 30 分钟后收尾（清理旧 ReplicaSet）
```

**"一次全量"** 在没有兼容性验证时风险极高。

### 回滚

```bash
kubectl rollout undo deploy/app
kubectl rollout status deploy/app
kubectl rollout history deploy/app
```

**回滚也要"兼容"**：如果新版本已经写了新格式数据，回滚可能读不了（所以"向前兼容"必须在发布前设计）。

### 五个"发布成功但用户报错"

**① 探针通过但依赖没就绪**

```
readiness 只查 /healthz（没查 DB 连接）
```

**② 配置没更新**

```
ConfigMap 更新了但 Pod 没重启（没 checksum 注解）
```

**③ DNS/证书问题**

```
新域名没解析 / 证书链不全（浏览器报错但 curl -k 正常）
```

**④ 只灰度了一部分流量，缓存串了**

```
新版本写入了旧格式缓存 → 旧版本读出错
```

**⑤ 副本间时钟/时区不一致**

```
token 过期判断出错
```

### 本章检查清单

```
□ maxUnavailable: 0 + maxSurge
□ 有 preStop + 优雅退出
□ terminationGracePeriodSeconds 足够
□ 接口/数据向前兼容
□ 有 PDB
□ 灰度分档且看指标
□ 回滚命令演练过
□ readiness 检查真实依赖
□ 配置变更会触发滚动
```
