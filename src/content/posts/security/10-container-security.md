---
title: 容器安全：从镜像到运行时的六道关
description: 镜像来源与最小化、非 root 与只读根文件系统、capabilities 收口、seccomp 与网络策略、密钥注入、以及逃逸风险怎么评估。
date: 2023-03-02
tags: [安全, 容器, Docker, Kubernetes]
---

### 一句话原则

**容器不是安全边界，但它可以是"减少爆炸半径"的工具**——前提是把它按最坏情况配置。

```
假设攻击者已经拿到容器内的执行权限，问：他能做什么？
```

六道关，就是逐步压缩这个"能做什么"。

### 第一关：镜像来源与最小化

```dockerfile
FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/app ./cmd/app

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
USER nonroot
ENTRYPOINT ["/app"]
```

要点：

- **固定 digest**，不用 `latest`：`FROM x@sha256:...`
- **多阶段构建**：最终镜像不含编译器、包管理器、源码。
- **distroless / alpine**：没有 shell，攻击者拿到执行权也没法 `cat /etc/passwd` 找下一步。

检查镜像里有什么：

```bash
docker sbom myimage:1.0            # 或 syft myimage:1.0
docker history myimage:1.0 --no-trunc
```

### 第二关：非 root 运行

```yaml
# k8s
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  allowPrivilegeEscalation: false
```

三个必须同时上：

1. `runAsNonRoot`：不满足就拒绝启动（而不是"以 root 跑着"）。
2. `allowPrivilegeEscalation: false`：禁止 setuid 提权。
3. 镜像里也设 `USER`：双层保险。

很多官方镜像默认 root，**不改就等于所有容器都是 root**。检查：

```bash
kubectl get pod <p> -o jsonpath='{.spec.containers[0].securityContext}'
```

### 第三关：capabilities 收口

容器默认带着一批 capabilities（`CHOWN`、`NET_RAW`、`SETUID` 等），很多根本用不到。

```yaml
securityContext:
  capabilities:
    drop: ["ALL"]
    add: ["NET_BIND_SERVICE"]   # 只有需要绑 80 的服务才加
```

常见需要：

| 能力 | 场景 |
| --- | --- |
| `NET_BIND_SERVICE` | 监听 <1024 端口 |
| `NET_ADMIN` | 配网络（VPN/代理类） |
| `SYS_TIME` | 改系统时间（几乎不该给） |
| `SYS_ADMIN` | **等价于 root**，绝不能给业务容器 |

`SYS_ADMIN` 是逃逸的常见跳板，加它基本等于放弃隔离。

### 第四关：只读根文件系统

```yaml
securityContext:
  readOnlyRootFilesystem: true
volumeMounts:
- name: tmp
  mountPath: /tmp
- name: cache
  mountPath: /var/cache/app
```

只读根文件系统能挡住：

- 攻击者上传 webshell 到 `/app`。
- 篡改二进制。
- 写入 crontab（虽然容器里一般没有 cron）。

代价：应用要写临时目录时必须显式挂卷。日志应该走 stdout，不要写文件。

### 第五关：seccomp / AppArmor

```yaml
# 用运行时默认 profile（推荐起点）
securityContext:
  seccompProfile:
    type: RuntimeDefault
```

`RuntimeDefault` 会拦掉约 40+ 个危险系统调用（`ptrace`、`reboot`、`mount` 的部分参数）。

自定义 profile 的门槛高，先上默认的，再按需放宽。

检查是否生效：

```bash
kubectl exec <pod> -- grep Seccomp /proc/self/status
```

### 第六关：网络与密钥

**网络策略**：默认拒绝所有，按需放通。

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```

然后给每个服务单独放通"谁能访问我、我能访问谁"。这能显著限制横向移动。

**密钥注入**：

| 方式 | 评价 |
| --- | --- |
| 写进镜像 / 环境变量明文 | 最差，镜像一泄露全泄露 |
| K8s Secret（base64） | 弱，能读 Secret 的人就能看到 |
| Secret 挂载成文件 + 严格 RBAC | 中 |
| Vault / KMS 动态注入 | 好，但要防"注入本身被滥用" |

```yaml
volumes:
- name: secret
  secret: { secretName: db-cred, defaultMode: 0400 }
```

**不要**把密钥放环境变量：`kubectl exec` 里 `env` 就能看到，且会被 child process 继承。

### 逃逸风险评估

判断一个容器"有多危险"，看四项：

```
① 是否 privileged: true           → 直接逃逸（等于宿主机 root）
② 是否挂载 docker.sock            → 可创建特权容器，等价逃逸
③ 是否 hostPath 挂载 / 或 /proc   → 可能改宿主机
④ 是否 hostNetwork / hostPID      → 能看到宿主机进程与网络
```

```bash
# 快速扫描集群里的高风险 Pod
kubectl get pod -A -o json | jq -r '
  .items[] | select(
    .spec.hostNetwork==true or
    (.spec.containers[].securityContext.privileged==true)
  ) | "\(.metadata.namespace)/\(.metadata.name)"'
```

这四项里任意一项成立，就不要指望"容器隔离"能救你。

### 上线检查清单

```
□ 镜像来自受控仓库，digest 固定
□ 多阶段构建 + 无 shell 基础镜像
□ 非 root（USER + runAsNonRoot）
□ allowPrivilegeEscalation: false
□ capabilities drop ALL，按需 add
□ readOnlyRootFilesystem + 显式挂卷
□ seccompProfile: RuntimeDefault
□ NetworkPolicy 默认拒绝
□ 密钥走文件挂载或 KMS，不进环境变量
□ 无 privileged / hostPath / docker.sock
```
