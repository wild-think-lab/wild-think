---
title: 第 4 章 · 配置与密钥：ConfigMap 与 Secret 的正确用法
module: 入门篇
summary: 配置从哪来、改配置怎么触发重启、Secret 到底安不安全、四种外置密钥方案、以及"改了配置没生效"的排查。
minutes: 16
---

### 配置的三条纪律

1. **镜像里不放环境相关配置**：同一个镜像要能跑在 dev/staging/prod。
2. **配置变更要走 Git**：谁改的、什么时候改的要可查。
3. **密钥绝不进镜像与 Git 明文**：镜像层可以被任何人 `docker history` 看到。

### ConfigMap

```bash
kubectl -n prod create configmap app-config \
  --from-file=app.yaml=./config/prod/app.yaml
```

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: prod
data:
  LOG_LEVEL: "info"
  app.yaml: |
    server:
      port: 8080
    db:
      max_open: 20
```

两种挂载方式：

```yaml
# ① 作为环境变量（单个 key）
envFrom:
- configMapRef: { name: app-config }

# ② 作为文件挂进容器
volumeMounts:
- name: cfg
  mountPath: /etc/app
volumes:
- name: cfg
  configMap: { name: app-config }
```

**配置文件方式更适合复杂结构**（YAML 嵌套用环境变量表达很别扭）。而且挂了文件后，容器里可以用 `inotify` 感知变化。

### 改了配置为什么不生效

关键点：**ConfigMap 挂成 volume 后，内容更新不会自动同步到运行中的容器**（kubelet 只在启动时挂载）。

```bash
kubectl -n prod edit configmap app-config
# 容器里看到的还是旧内容！
```

三种解法：

1. **滚动重启**（最常用）：`kubectl rollout restart deploy/order-api`
2. 挂载时用 `subPath` 的写法反而更糟（连更新文件都看不到）
3. 用支持热加载的配置中心（Apollo/Nacos/Consul），或让应用定时拉取

环境变量方式更彻底：**环境变量只在容器启动时注入，改了必须重启**，没有热更新可能。

### Secret 的真实安全边界

Secret 只是"Base64 编码 + etcd 存储"，**默认不加密**。谁能读 etcd、谁能 `kubectl get secret`，谁就能拿到明文。

```bash
kubectl -n prod get secret order-secret -o jsonpath='{.data.db-password}' | base64 -d
```

三个改进方向：

1. **开启 etcd 加密**（`--encryption-provider-config`，KMS 提供密钥）。
2. **RBAC 收紧**：只给需要的人 `get secret` 权限，且按 namespace 隔离。
3. **不把密钥放进 K8s**：用外部密钥管理。

### 四种外置密钥方案

| 方案 | 原理 | 优点 | 缺点 |
| --- | --- | --- | --- |
| Sealed Secrets | 用集群公钥加密后存 Git | 简单、可 Git 托管 | 换集群要重加密 |
| SOPS + age | 文件级加密，Git 存密文 | 灵活、支持多类型文件 | 需要管理 age 密钥 |
| External Secrets Operator | 从 Vault/AWS SM 同步成 Secret | 密钥不落 Git | 多一层组件 |
| Vault Agent Injector | 注入到 Pod | 动态租约、可轮换 | 依赖 Vault 可用性 |

中小团队最省心的是 **External Secrets Operator**：Git 里只放"从哪个路径取哪个 key"，真实值在 Vault/云密钥服务里。

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: order-secret
spec:
  refreshInterval: 1h
  secretStoreRef: { name: vault-backend, kind: SecretStore }
  target: { name: order-secret }
  data:
  - secretKey: db-password
    remoteRef: { key: prod/order/db, property: password }
```

### ServiceAccount 与镜像拉取密钥

私有镜像仓库要配 `imagePullSecrets`：

```bash
kubectl -n prod create secret docker-registry regcred \
  --docker-server=registry.example.com \
  --docker-username=robot \
  --docker-password='***'
```

```yaml
spec:
  template:
    spec:
      imagePullSecrets:
      - name: regcred
```

更规范的做法是给 namespace 绑定一个 ServiceAccount，让它自动带上拉取密钥（`kubectl patch serviceaccount default -p ...`）。

### 环境变量 vs 文件：怎么选

| 场景 | 选择 |
| --- | --- |
| 少量简单值（端口、日志级别） | 环境变量 |
| 结构化配置（YAML/JSON） | 挂文件 |
| 密钥 | Secret + 环境变量或文件均可 |
| 需要热更新 | 挂文件 + 应用监听，或配置中心 |
| 多环境差异大 | 每个环境一套 ConfigMap，目录分开管 |

### 一个常见的错误配置

```yaml
env:
- name: DB_HOST
  value: localhost      # 写死在本机 = 容器里连自己
```

容器里的 `localhost` 是容器自己，连不到同 Pod 的其他容器（除非共享网络命名空间），更连不到别的 Pod。要用 **Service 名**：

```yaml
- name: DB_HOST
  value: mysql.prod.svc.cluster.local
```

这一条在"本地跑得好、上 K8s 连不上数据库"的问题里出现频率极高。
