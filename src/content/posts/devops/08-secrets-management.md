---
title: 密钥管理：别再把密码写进配置文件和环境变量
description: 四种存放方式的真实安全等级、Vault 的核心用法、Sealed Secrets 与 SOPS 的适用场景、轮换与最小权限怎么落地。
date: 2026-11-27
tags: [安全, 密钥管理, Vault, Kubernetes]
---

### 四种存放方式的安全等级

| 方式 | 泄露风险 | 评价 |
| --- | --- | --- |
| 写进代码 / 配置文件并提交 Git | 极高 | 最差，Git 历史永久留存 |
| 环境变量明文 | 高 | `env` 可见、被子进程继承、可能进日志 |
| K8s Secret（base64） | 中 | 能读 Secret 的人就能看明文 |
| 外部密钥服务（Vault/KMS） | 低 | 动态签发、可审计、可撤销 |

前两种基本等于"没有密钥管理"。第三种只是"稍微好一点"。

### K8s Secret 的真相

```bash
kubectl get secret db-cred -o jsonpath='{.data.password}' | base64 -d
```

一行命令就能拿到明文。所以：

- Secret 不是加密存储，只是"集中存放"。
- 必须配 RBAC：只有需要它的 ServiceAccount 能读。
- 开启 etcd 加密（`--encryption-provider-config`），防止 etcd 备份泄露。

```yaml
# etcd 加密配置
kind: EncryptionConfiguration
resources:
- resources: ["secrets"]
  providers:
  - aescbc:
      keys:
      - name: key1
        secret: <base64>
```

### Vault：动态凭据才真正解决问题

静态密钥的问题是"一旦泄露就永久有效"。Vault 的解法是**每次连接都发一个新凭据，用完即失效**。

```bash
# ① 启用数据库动态凭据
vault secrets enable database
vault write database/config/mysql \
  plugin_name=mysql-database-plugin \
  connection_url="{{username}}:{{password}}@tcp(db:3306)/" \
  allowed_roles="app" \
  username="vault" password="..."

# ② 定义角色：每次签发一个只能用 1 小时的账号
vault write database/roles/app \
  db_name=mysql \
  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT SELECT,INSERT ON app.* TO '{{name}}'@'%';" \
  default_ttl="1h" max_ttl="24h"

# ③ 应用获取
vault read database/creds/app
```

好处：

1. 泄露的凭据 1 小时后自动失效。
2. 每个实例独立账号，出问题能定位到具体实例。
3. 全部操作有审计日志。

代价：应用要能"定期刷新凭据"，且 Vault 本身要高可用（它挂了业务就起不来）。

### 三种方案怎么选

| 场景 | 方案 |
| --- | --- |
| 少量静态配置（如 API key） | Sealed Secrets / SOPS，加密后进 Git |
| 数据库/云资源凭据 | Vault 动态凭据（或云厂商的 IAM Role） |
| K8s 里的 Secret 分发 | External Secrets Operator + Vault/AWS SM |
| 单机/小团队 | SOPS + age 密钥，最简单 |

**Sealed Secrets**：把 Secret 用集群公钥加密，加密后的值可以安全进 Git，只有该集群能解密。

```bash
kubeseal --format yaml < secret.yaml > sealed-secret.yaml
kubectl apply -f sealed-secret.yaml
```

**SOPS**：加密文件里的特定字段，适合"配置文件里只有几个敏感项"。

```bash
sops -e -i config.yaml        # 只加密 values，structure 保持可读
sops -d config.yaml
```

### 环境变量为什么不行

三个具体原因：

```bash
# ① 任何能 exec 的人都能看到
kubectl exec <pod> -- env | grep PASS

# ② 会被子进程继承（日志、错误上报都可能带出去）
# ③ 崩溃转储（core dump）里是明文
```

改用文件挂载 + 严格权限：

```yaml
volumes:
- name: cred
  secret:
    secretName: db-cred
    defaultMode: 0400
volumeMounts:
- name: cred
  mountPath: /run/secrets
  readOnly: true
```

应用从 `/run/secrets/password` 读取。至少不会出现在 `env` 里。

### 轮换：比"存哪"更重要

密钥管理的真正考验是"泄露后多久能全部换掉"。

设计要点：

1. **系统同时接受新旧两个密钥**（灰度期）。
2. **轮换过程可自动化**（一条命令或定时任务）。
3. **轮换后验证**（旧密钥确实失效）。

```python
# 双密钥验证：新签用 new，验签接受 new + old
def verify(token):
    for key in (NEW_KEY, OLD_KEY):
        try:
            return decode(token, key)
        except InvalidToken:
            continue
    raise Unauthorized()
```

没有"双密钥过渡期"的系统，轮换必然导致一次全站故障。

### 最小权限

```
□ 每个服务一个凭据，不共用
□ 凭据权限只覆盖它真正需要的表/桶/路径
□ 有到期时间（静态密钥也要设 TTL）
□ 有审计（谁在什么时候用了哪个凭据）
```

共用凭据的后果：一个服务泄露，所有服务都要跟着换，且无法从日志判断是谁泄露的。

### 检查清单

```
□ Git 历史里没有明文密码（用 gitleaks 扫一遍）
□ 生产 Secret 已开 etcd 加密
□ 敏感值不走环境变量，走文件挂载
□ 关键凭据可自动轮换，且有双密钥过渡
□ 每个服务独立凭据，权限最小
□ 有"凭据泄露应急预案"（谁负责、多久换完）
```

```bash
# 扫 Git 历史里的疑似密钥
gitleaks detect --source . --verbose
```
