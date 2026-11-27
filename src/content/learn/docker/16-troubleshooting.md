---
title: 容器排障实战：进程、网络与文件系统
module: 进阶篇
summary: 容器里没有 ps/netstat 怎么办、命名空间视角、ephemeral 容器、五个"进了容器查不出"的原因。
minutes: 45
---

### 先分清"三个视角"

```
① 宿主视角：docker ps / crictl ps（看到所有容器）
② 容器内视角：exec 进去（可能没有工具）
③ 命名空间视角：nsenter（借用宿主工具看容器网络）
```

**"容器里没 ps"** → 用宿主工具 + nsenter，或用临时调试容器。

### 常用命令

```bash
docker ps -a
docker inspect <id> --format '{{.State.Status}} {{.State.ExitCode}}'
docker logs --tail 100 -f <id>
docker stats --no-stream
```

**判据**：

```
ExitCode 137 = OOMKill 或 SIGKILL
ExitCode 1 = 应用自身错误
Restarting 循环 = 看 logs 前 30 行
```

### 没有工具的镜像怎么查

```bash
# 用同镜像起一个带 shell 的调试容器，共享目标命名空间
docker run -it --rm --network container:<target> \
  --pid container:<target> nicolaka/netshoot

# 或 nsenter
PID=$(docker inspect -f '{{.State.Pid}}' <target>)
nsenter -t $PID -n ss -antp
nsenter -t $PID -p ps aux
```

**效果**：不发包、不改镜像，直接看到容器内真实状态。

### K8s 里的等价操作

```bash
kubectl exec -it app-0 -- sh
kubectl debug -it app-0 --image=nicolaka/netshoot --target=app
kubectl logs app-0 --previous     # 上一个崩溃实例的日志
```

**`--previous`** 是排查 CrashLoopBackOff 的关键。

### 网络问题定位

```bash
# 容器内 DNS
nsenter -t $PID -n cat /etc/resolv.conf
nsenter -t $PID -n getent hosts db
# 端口监听
nsenter -t $PID -n ss -lntp
# 出站连通
nsenter -t $PID -n curl -m 3 -v http://db:3306
```

**判据**：

```
DNS 解析失败 → resolv.conf / CoreDNS
端口未监听 → 应用监听 127.0.0.1
连接超时 → NetworkPolicy / 安全组
```

### 文件系统问题

```bash
docker diff <id>              # 容器层改了什么
docker cp <id>:/app/log ./    # 拷出来
nsenter -t $PID -m df -h      # 容器视角的磁盘
```

**"磁盘满但宿主还有空间"** → 容器层或卷配额满。

### 五个"进了容器查不出"

**① 镜像没工具（无 ps/ss/curl）**

```
用 netshoot 或 nsenter
```

**② 只看容器不看宿主**

```
cgroup 限额、节点压力在宿主侧
```

**③ 日志被 stdout 覆盖**

```
应用写文件而非 stdout → docker logs 空
```

**④ 查的是旧容器**

```
同名容器重建，inspect 的是新的
```

**⑤ 时间不对**

```
容器时区错 → 日志时间与真实错位
```

### 五个"以为容器挂了其实没挂"

```
① 健康检查失败但进程正常（依赖不通）
② OOMKill 后自动重启，看起来"偶发重启"
③ readiness 未通过 → 不接流量（不是崩）
④ 探针端口写错
⑤ 节点 NotReady 导致 Pod 被驱逐
```

### 检查清单

```
□ 会看 ExitCode（137/1/143）
□ 会用 --previous 看崩溃前日志
□ 会用 netshoot/nsenter 借工具
□ 区分宿主/容器/命名空间三视角
□ 会看 docker diff 与 cgroup 限额
□ 确认日志走 stdout
□ 确认时区
□ 健康检查与 readiness 分开看
□ 有 OOMKill 告警
□ 有节点 NotReady 告警
```
