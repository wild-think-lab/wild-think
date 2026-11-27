---
title: 容器安全：权限收缩与运行时加固
module: 进阶篇
summary: capabilities、seccomp、只读根、user namespace、镜像签名，五个"容器等于 root"的误解。
minutes: 45
---

### 默认权限有多大

```
容器共享宿主内核 → 逃逸即提权
默认带一批 capabilities（不止你以为的那几个）
root 在容器内映射到宿主 root（除非开了 userns）
```

```bash
docker run --rm alpine capsh --print
```

**"容器隔离所以安全"** 是最大的误解。

### 丢掉 capabilities

```bash
docker run --rm --cap-drop=ALL --cap-add=NET_BIND_SERVICE nginx
```

```yaml
# K8s
securityContext:
  capabilities:
    drop: ["ALL"]
    add: ["NET_BIND_SERVICE"]
```

**判据**：业务不需要的 capability 一个都不留。

### 只读根文件系统

```bash
docker run --read-only --tmpfs /tmp --tmpfs /run app
```

```yaml
securityContext:
  readOnlyRootFilesystem: true
```

**收益**：木马无法落地写文件；**代价**：要显式给可写目录。

### 非 root 运行

```dockerfile
RUN useradd -u 10001 -r app
USER 10001
```

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
```

**"镜像里 USER 没设"** → 默认 root，逃逸后直接是宿主 root。

### seccomp / AppArmor

```bash
docker run --security-opt seccomp=default.json app
docker run --security-opt no-new-privileges app
```

```
no-new-privileges：禁止 setuid 提权（很实用）
```

### 五个"容器等于 root"的误解

**① root 在容器里不是 root**

```
错：默认是宿主 root（除非 userns-remap）
```

**② 挂载 docker.sock 很安全**

```
挂 sock = 给容器宿主 root（可起特权容器）
```

**③ privileged 只是"方便调试"**

```
privileged 等于几乎无隔离
```

**④ 只读根就安全了**

```
还能通过挂载卷/临时目录写入
```

**⑤ 镜像扫描过就没问题**

```
运行时配置（cap/特权/挂载）才是更大的风险
```

### 镜像供应链

```
① 只用可信基础镜像
② 镜像签名（cosign）与校验
③ 扫描高危（阻断）
④ 固定 digest（不用可变 tag）
```

```bash
cosign verify --key cosign.pub registry.example.com/app:1.0
```

### 五个"加固后跑不起来"

```
① 丢了 CHOWN（写文件失败）
② 只读根但应用要写 /tmp
③ 非 root 但监听 80（需要 NET_BIND_SERVICE 或用 8080）
④ seccomp 拦了必要的 syscall
⑤ userns 后挂载卷属主不匹配
```

### 检查清单

```
□ cap-drop ALL + 按需 add
□ 非 root 用户运行
□ readOnlyRootFilesystem（必要目录用 tmpfs/卷）
□ no-new-privileges
□ 不挂 docker.sock
□ 禁 privileged（白名单例外）
□ 有 seccomp/AppArmor 配置
□ 镜像固定 digest + 签名校验
□ 扫描高危阻断
□ 有运行时安全告警（异常 exec/写系统目录）
```
