---
title: DevOps 岗面试：从 CI/CD 到"线上出事了怎么办"
description: 高频题的真实考点、容易答错的边界问题、可加分的具体数字、以及反问环节该问什么。
date: 2026-11-27
tags: [面试, DevOps, CI/CD, Kubernetes]
---

### 高频题的真实考点

| 问题 | 面试官想听 |
| --- | --- |
| 讲讲你们的 CI/CD 流程 | 你能说清"从提交到上线"每一步，以及卡点在哪 |
| 镜像怎么做的？ | 基础镜像选择、多阶段构建、体积、漏洞扫描 |
| K8s 滚动更新怎么保证不中断 | 探针、优雅退出、`maxSurge/maxUnavailable` |
| 线上 CPU 100% 怎么查 | 分层定位：进程 → 线程 → 堆栈 |
| 怎么保证发布可回滚 | 版本可追溯、数据库变更可逆、灰度 |
| 监控告警怎么配 | 指标 → 阈值 → 通知 → 处置，有降噪 |

### ① CI/CD：要有"时间数字"

差的回答："我们用 Jenkins，提交后自动构建部署。"

好的回答：

```
开发提交 → GitLab 触发 Pipeline
  → 单测（约 2 分钟，不过则阻断）
  → 构建镜像（多阶段，约 1.5 分钟）
  → 推镜像仓（带 git sha tag）
  → 部署到预发（自动）
  → 冒烟测试（约 3 分钟）
  → 人工审批 → 生产灰度 10% → 全量
全流程约 12 分钟；回滚只需把镜像 tag 切回上一个版本，约 1 分钟。
```

数字体现你真正跑通过。

### ② 镜像：四个要点

```dockerfile
# 多阶段构建 + 非 root + 固定基础镜像
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app ./cmd/app

FROM alpine:3.20
RUN adduser -D -u 10001 app
COPY --from=build /out/app /app
USER 10001
ENTRYPOINT ["/app"]
```

考点：

- **多阶段构建**减少体积（几百 MB → 十几 MB）。
- **非 root 运行**。
- **基础镜像固定小版本**（`alpine:3.20` 而不是 `alpine:latest`）。
- **漏洞扫描**（trivy）。

```bash
trivy image --severity HIGH,CRITICAL myapp:1.0
```

### ③ 滚动更新不中断：四个条件

```yaml
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    spec:
      containers:
      - name: app
        readinessProbe:
          httpGet: { path: /ready, port: 8080 }
          initialDelaySeconds: 5
          periodSeconds: 5
        lifecycle:
          preStop:
            exec:
              command: ["sh", "-c", "sleep 5 && curl -X POST localhost:8080/drain"]
      terminationGracePeriodSeconds: 30
```

四个条件：

1. **readinessProbe**：没就绪不进 Endpoints。
2. **preStop + 优雅退出**：先从 LB 摘掉，处理完存量请求。
3. **`terminationGracePeriodSeconds`** 足够长（要大于最慢请求时长）。
4. **maxUnavailable: 0**：先加后减，保证容量不降。

缺任何一条都可能出现"更新瞬间 502"。

### ④ CPU 100% 排查顺序

```bash
# 1. 找到进程
top -o %CPU
# 2. 找到线程
top -H -p <pid>
# 3. 线程转栈
printf '%x\n' <tid>                    # 转十六进制
jstack <pid> | grep -A 20 'nid=0x<hex>'
# 或 Go 服务：pprof
curl http://localhost:6060/debug/pprof/profile?seconds=30 > cpu.prof
go tool pprof -top cpu.prof
```

**分层的意义**：不要一上来就 dump 堆，先确定是"哪个进程、哪个线程、在做什么"。

### ⑤ 可回滚的三个前提

| 前提 | 落地方式 |
| --- | --- |
| 版本可追溯 | 镜像 tag = git sha；Deployment 记录 revision |
| 数据库变更可逆 | 迁移脚本必须有 down，或用"扩展-收缩"两阶段 |
| 快速切换 | `kubectl rollout undo` 或改镜像 tag |

数据库是回滚的最大障碍：

```
安全做法（扩展/收缩）：
① 加新字段（兼容旧代码）
② 发布代码（双写）
③ 数据回填
④ 切读新字段
⑤ 删旧字段
每一步都可独立回滚。
```

### ⑥ 监控告警：要有"降噪"意识

```
指标采集（Prometheus） → 规则（合理阈值 + for 持续时间）
 → 分级（P1 电话 / P2 IM / P3 邮件）
 → 聚合（同一服务同类告警合并）
 → 值班（谁接、多久响应）
```

加分点：**说出你的告警收敛方法**，例如"同一 Deployment 的 Pod 重启告警按 5 分钟窗口聚合为一条"。

### 容易答错的边界题

**Q：K8s 的 Service 是怎么工作的？**

差的回答："它是个负载均衡。"

好的回答：Service 是**虚拟 IP + iptables/IPVS 规则**，把访问 ClusterIP 的流量 DNAT 到某个 Pod IP。`kube-proxy` 负责维护规则。所以它**不是真正的代理**，不经过用户态转发（iptables 模式下）。

**Q：Pod 之间怎么通信？**

同节点：通过 cni0/veth 网桥直接二层可达。跨节点：由 CNI 决定（Calico 用 BGP 或 IPIP，Flannel 用 VXLAN）。**要说出你集群用的是哪种**。

**Q：怎么限制 Pod 资源？**

`requests` 决定调度，`limits` 决定 cgroup 上限。**只说 limits 会被追问**：如果只设 limits 不设 requests，调度会按 limits 算，容易造成节点超卖。

### 反问环节

问这三个，比问薪资更能体现水平：

1. "你们现在的发布频率是多少？回滚最快多久？"（看工程成熟度）
2. "线上故障的平均恢复时间（MTTR）大概多少？上次 P1 是什么原因？"（看是否有复盘文化）
3. "这个岗位最需要解决的第一个问题是什么？"（看需求是否清晰）

### 检查清单（面试前准备）

```
□ 能画出自己项目的完整架构图（含网络与数据流）
□ 有 3 个"数字"：发布时长、MTTR、集群规模
□ 有 1 个完整排障故事（现象→定位→根因→改进）
□ 有 1 个"做错了然后修正"的故事
□ 能说清集群用的 CNI 与 Ingress 方案
□ 准备好 3 个反问
```
