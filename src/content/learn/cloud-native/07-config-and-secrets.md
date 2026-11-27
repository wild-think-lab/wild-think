---
title: 第 7 章 · 配置与密钥：别把密码写进镜像
module: 熟练篇
summary: ConfigMap 的更新陷阱、Secret 的真实安全性、外部密钥方案（Vault/ESO）、以及五个"改了配置没生效"的原因。
minutes: 45
---

### ConfigMap 与 Secret 的差别

```
ConfigMap：明文配置（可读）
Secret：base64 编码（不等于加密）
```

**"Secret 就安全了"** → etcd 里有、能读 Secret 的人就能解码。

### ConfigMap 更新的坑

```
Pod 不会自动感知 ConfigMap 变化
→ 需要重启或 reload（应用要支持）
```

```yaml
# 让滚动时能感知变化（checksum 注解）
metadata:
  annotations:
    checksum/config: "{{ include (print $.Template.BasePath "/cm.yaml") . | sha256sum }}"
```

**"改了 ConfigMap 但服务还是旧配置"** → 这是最常见的问题。

### 挂载方式

```yaml
volumes:
- name: cfg
  configMap: {name: app-config}
volumeMounts:
- {name: cfg, mountPath: /etc/app, readOnly: true}
```

**注意**：整体挂载目录会覆盖镜像里的文件（用 `subPath` 只挂单个文件）。

### Secret 的正确用法

```bash
kubectl create secret generic db --from-literal=password='xxx'
```

**更好的方案**：

```
① 外部密钥管理（Vault + External Secrets Operator）
② 云上 Secret Manager / KMS
③ 加密 Secret（Sealed Secrets，可提交到 Git）
```

**"把 Secret YAML 提交进 Git"** → base64 不等于脱敏。

### External Secrets Operator（推荐）

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata: {name: db-secret}
spec:
  refreshInterval: 1h
  secretStoreRef: {name: vault, kind: SecretStore}
  target: {name: db, creationPolicy: Owner}
  data:
  - secretKey: password
    remoteRef: {key: secret/app/db, property: password}
```

**好处**：真实值不进 Git、可轮换（refreshInterval）。

### 五个"改了配置没生效"

**① ConfigMap 改了没重启**

```
Deployment 的 Pod 模板没变 → 不会触发滚动
```

**② checksum 注解缺失**

```
Helm 无法感知 → 不触发滚动
```

**③ 挂载覆盖**

```
mountPath 是目录 → 覆盖镜像里的其他文件
```

**④ 环境变量优先级**

```
Deployment env 覆盖了 ConfigMap 的 envFrom
```

**⑤ 应用缓存了配置**

```
启动时读一次，之后不再读（需要 reload 接口）
```

### 本章检查清单

```
□ 配置外置（不写进镜像）
□ 有 checksum 注解触发滚动
□ Secret 来自外部密钥系统（或加密）
□ 不把 Secret 明文/裸 base64 提交 Git
□ 挂载用 subPath（避免覆盖）
□ 应用支持 reload 或"重启生效"明确
□ 有配置变更记录
□ 有关键配置的校验（启动时 fail fast）
□ 有密钥轮换流程
□ 有"配置漂移"检查
```
