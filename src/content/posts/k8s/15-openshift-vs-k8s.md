---
title: OpenShift 和原生 K8s 到底差在哪
description: 多出来的东西（Route/SCC/OperatorHub/ImageStream）、企业为什么买它、以及运维者需要额外掌握的四件事。
date: 2026-11-27
tags: [OpenShift, Kubernetes, 企业]
---

### 它不是"另一个 K8s"

```
OpenShift = Kubernetes + 一堆默认装好的企业组件 + 强约束的安全模型
```

原生 K8s 是"裸引擎"，OpenShift 是"整车"。

### 多出来的核心组件

| 组件 | 作用 | 原生 K8s 对应 |
| --- | --- | --- |
| Route | 七层入口（自动 TLS） | Ingress（需自己装 Controller） |
| SCC | 安全上下文约束 | PodSecurity（较松） |
| ImageStream | 镜像版本抽象（可触发构建/部署） | 无（直接用镜像 tag） |
| OperatorHub | Operator 市场 | 手动装 |
| BuildConfig | 内置镜像构建 | 需外部 CI |
| 内置监控 | Prometheus + Alertmanager 预装 | 自己装 |

**Route 的方便之处**：

```yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: app
spec:
  host: app.apps.example.com       # 自动生成证书时留空即可
  to:
    kind: Service
    name: app
  tls:
    termination: edge               # 边缘终止 / passthrough / reencrypt
```

**零配置 HTTPS**：OpenShift 有通配符证书 `*.apps.<cluster-domain>`，Route 用子域名就自动有 HTTPS。

### ImageStream 与部署触发

```yaml
apiVersion: image.openshift.io/v1
kind: ImageStream
metadata:
  name: app
```

```yaml
# DeploymentConfig 或 Deployment 引用
spec:
  triggers:
  - type: ImageChange
    imageChangeParams:
      automatic: true
      containerNames: ["app"]
      from:
        kind: ImageStreamTag
        name: app:latest
```

**它的价值**：`app:latest` 是个"逻辑指针"，推新镜像后自动触发滚动更新，不用改 Deployment 里的 image。

**坑**：`latest` + 自动触发 = 谁推谁上线（不可控）。生产应该用带版本的 tag。

### SCC：比 K8s 严格得多

```
OpenShift 默认禁止容器以 root 运行
→ 用随机 UID 运行（如 1000000000+）
→ 挂载卷的权限需要 fsGroup 或显式 chown
```

**典型症状**：

```
容器报 permission denied（写 /var/lib/mysql 或 /data）
原因：容器以随机 UID 运行，卷属于 root:root
```

**修法**：

```yaml
securityContext:
  fsGroup: 1000
```

或用一个允许特定 UID 的 SCC：

```bash
oc adm policy add-scc-to-user anyuid -z default -n myns
```

**`anyuid` 是危险的**（等于放开 root 限制），只应该给确实需要的 ServiceAccount，而不是整个命名空间。

**这是从 K8s 迁到 OpenShift 最常见的"第一天问题"**：所有原本以 root 跑的自制镜像都会起不来。

### 运维者需要额外掌握的四件事

**① `oc` 而不是 `kubectl`**

```bash
oc login https://api.cluster.example.com:6443
oc project myns
oc get pods
oc adm top nodes
```

大部分 `kubectl` 命令 `oc` 都支持，且 `oc` 有更多的管理员命令。

**② Project 与 Namespace 的关系**

```
Project = Namespace + 注解（显示名、描述）
普通用户用 oc new-project 创建
```

普通用户**不能随便创建 Project**（受配额与 RBAC 限制），这点与原生 K8s 不同。

**③ 集群更新（upgrade）**

```bash
# 查看可用版本
oc adm upgrade

# 执行更新
oc adm upgrade --to=4.14.5
```

**更新是"运维事件"**：会滚动重启控制面与所有节点上的组件，通常要 1–3 小时。要提前：

```
- 确认 Operator 都支持目标版本
- 备份 etcd
- 通知业务方
```

**④ 节点与机器配置**

```
MachineConfigPool：按节点角色分组
MachineConfig：声明式节点配置（如内核参数、systemd unit）
改完 → MCO 自动滚动重启对应节点
```

**这是最容易踩坑的地方**：改一个 MachineConfig，**整个池的节点会依次重启**（可能一小时）。

### 企业为什么买它

```
① 合规：默认就有强安全基线（SCC、SELinux、审计日志）
② 支持：厂商 SLA（出问题有人兜）
③ 一体化：监控、日志、CI/CD、镜像仓库都在里面
④ Operator 生态：很多商业软件只提供 OpenShift Operator
⑤ 多租户：Project 配额 + SCC + 网络策略开箱可用
```

**代价**：

```
① 授权费用（按核/按订阅）
② 每个版本都要升级（不能长期不动）
③ 学习曲线（SCC/MCO 是额外的）
④ 定制受限（不要随便改控制面）
```

### 迁移时的实际清单

```
□ 镜像不能以 root 跑（或用 fsGroup / 指定 SCC）
□ 去掉 hostPath（改用 PVC）
□ 检查是否依赖特权（privileged / NET_ADMIN）
□ 检查是否写死 UID/GID
□ Ingress 改成 Route（或保留 Ingress，但要用支持它的 Controller）
□ 镜像 tag 不要用 latest（ImageStream 会跟着变）
□ 自建 CI 改为 BuildConfig 或保留外部 CI（只推 ImageStream）
□ 资源 requests 必须写（OpenShift 有默认配额）
```

### 什么时候不要用 OpenShift

```
① 团队只有 2–3 人、规模 < 10 节点 → 原生 K8s + 自己装监控更省
② 预算敏感 → 原生 K8s
③ 需要深度定制控制面 → 原生 K8s
④ 只需要"跑几个容器" → 直接用 Docker/Compose
```

**"用了 OpenShift 但没有运维能力"是最糟的状态**：贵、又不能升级、出问题还是不会修。

### 检查清单

```
□ 镜像能非 root 运行（或配置 fsGroup）
□ 不用 hostPath，全部 PVC
□ 不写死 UID
□ 镜像 tag 带版本，不用 latest + 自动触发
□ 明确 Ingress 还是 Route
□ MachineConfig 变更安排在维护窗口
□ 升级前备份 etcd、确认 Operator 兼容
□ SCC 只给需要的 SA，不给整个命名空间 anyuid
□ 资源 requests 全部填写
```
