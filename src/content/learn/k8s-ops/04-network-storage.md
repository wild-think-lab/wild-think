---
title: 第 4 章：网络与存储排障
module: 熟练篇
summary: Pod 五层排查顺序、CNI 与 MTU、PVC 挂不上的六种原因、iSCSI/NFS 卡住的处理。
minutes: 50
---

### Pod 网络五层

```
① 容器内：ip a、端口监听
② 同节点：Pod 之间能不能通
③ 跨节点：宿主机路由/隧道
④ Service：kube-proxy/IPVS 规则
⑤ Ingress：入口到 Service 的映射
```

**"按层测"** 比"直接怀疑 CNI"高效得多。

### 诊断容器

```bash
kubectl debug -it app-xxx --image=nicolaka/netshoot --target=app
```

```bash
ip a; ip r
nslookup kubernetes.default
curl -sv http://svc.ns.svc:80
tcpdump -i any -nn port 80
```

### MTU 检查

```
VXLAN 封装 → Pod MTU 通常 1450
```

```bash
ip link show eth0 | grep mtu
ping -M do -s 1400 <target>
```

**"小包通大包卡"** = MTU 问题。

### Service 不通（四种）

```
① selector 不匹配（Endpoints 为空）
② targetPort 写错
③ Service 是 ClusterIP 但 Pod 在别的 ns（正常不通）
④ kube-proxy 模式问题（IPVS 里没有规则）
```

```bash
kubectl get endpointslices -l kubernetes.io/service-name=svc
kubectl get svc svc -o yaml | grep -A3 ports
```

### 存储：PVC 挂不上的六种原因

```
① StorageClass 不存在/名字写错
② PVC 与 SC 的 accessModes 不匹配
③ 容量不足（后端没空间）
④ 绑定了旧 PV（claim 冲突）
⑤ 节点上插件（CSI）没起来
⑥ 有状态服务用了"独占"卷但被多 Pod 挂
```

```bash
kubectl get pvc
kubectl describe pvc data-app-0
kubectl get pods -n kube-system | grep csi
kubectl get sc
```

**`describe pvc` 的 Events** 一般直接给出原因。

### 六种常见卷问题

| 现象 | 首查 |
| --- | --- |
| Pod 卡 ContainerCreating | describe pod 的 Events（挂载失败） |
| 读写很慢 | 后端存储（NFS/iSCSI/云盘）延迟 |
| 多 Pod 挂同一卷冲突 | accessMode（RWO vs RWX） |
| 扩容后容量没变 | 文件系统未 resize（有些需重启/手工） |
| 卷消失 | PV 的回收策略 Delete + SC 默认策略 |
| 节点挂了卷挂不上 | 多路径/会话残留（iSCSI 需清理） |

### iSCSI 会话清理（常见坑）

```bash
iscsiadm -m session
iscsiadm -m node -u     # logout
iscsiadm -m node -o delete
```

**"节点异常重启后卷挂不上"** 常是会话残留导致后端拒绝。

### NFS 卡住

```bash
mount | grep nfs
# 卡住时
stat /mnt/nfs          # 会 hang
# 检查
showmount -e nfs-server
rpcinfo -p nfs-server
```

**"hang 住"** 说明服务端不可达（不是权限问题）。

### 本章检查清单

```
□ 有 netshoot 类调试镜像
□ 按五层顺序排查
□ 知道 Pod MTU 与封装关系
□ 会看 Endpoints/EndpointSlice
□ 会读 describe pvc 的 Events
□ 知道 accessMode 语义
□ 会清 iSCSI 会话
□ 存储有延迟监控
□ 有"卷挂不上"的 runbook
```
