---
title: 实验报告：用 kubeadm 从零搭一套三节点 Kubernetes
description: 目的、环境、原理、步骤、验证、注意事项、总结与附录脚本，一次做完能留下的完整记录。
date: 2026-11-27
tags: [实验, Kubernetes, kubeadm, 集群搭建]
---

### 一、实验目的

1. 理解 K8s 控制面与工作节点的组件分工。
2. 用 kubeadm 手工搭建 1 主 2 从集群，不依赖任何托管服务。
3. 验证集群可用性：调度、网络、存储、DNS 四个基础能力。
4. 记录每一步的验证方法，形成可复现的脚本。

### 二、环境

| 角色 | 主机名 | IP | 规格 |
| --- | --- | --- | --- |
| control-plane | k8s-m1 | 192.168.56.11 | 2C 4G |
| worker | k8s-w1 | 192.168.56.21 | 2C 2G |
| worker | k8s-w2 | 192.168.56.22 | 2C 2G |

系统：Ubuntu 22.04，容器运行时：containerd，CNI：Calico，Pod 网段 `10.244.0.0/16`。

### 三、原理要点

```
kube-apiserver  ：唯一入口，所有读写都经过它（认证→鉴权→准入）
etcd            ：唯一真相来源，存所有对象
kube-scheduler  ：为新 Pod 选节点（过滤 + 打分）
kube-controller-manager：期望状态与实际状态的收敛器
kubelet         ：节点上的"代理人"，负责真正把容器跑起来
kube-proxy      ：实现 Service 的转发规则（iptables/ipvs）
```

一句话：**控制面只负责"写期望"，kubelet 负责"让它发生"**。

### 四、步骤

#### 4.1 所有节点：基础准备

```bash
# 主机名与 hosts
hostnamectl set-hostname k8s-m1      # 各节点对应修改
cat >>/etc/hosts <<'EOF'
192.168.56.11 k8s-m1
192.168.56.21 k8s-w1
192.168.56.22 k8s-w2
EOF

# 关闭 swap（kubelet 默认要求）
swapoff -a
sed -i '/ swap / s/^/#/' /etc/fstab

# 内核模块与转发
cat >/etc/modules-load.d/k8s.conf <<'EOF'
overlay
br_netfilter
EOF
modprobe overlay && modprobe br_netfilter

cat >/etc/sysctl.d/k8s.conf <<'EOF'
net.bridge.bridge-nf-call-iptables=1
net.bridge.bridge-nf-call-ip6tables=1
net.ipv4.ip_forward=1
EOF
sysctl --system
```

**验证**：

```bash
lsmod | grep -E 'overlay|br_netfilter'
sysctl net.ipv4.ip_forward          # 必须是 1
free -m | grep Swap                 # 应为 0
```

#### 4.2 所有节点：安装 containerd

```bash
apt update && apt install -y containerd
mkdir -p /etc/containerd
containerd config default >/etc/containerd/config.toml
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
systemctl restart containerd && systemctl enable containerd
```

`SystemdCgroup = true` 必须改，否则 kubelet 与 containerd 的 cgroup 驱动不一致，Pod 会起不来。

**验证**：

```bash
systemctl is-active containerd
grep SystemdCgroup /etc/containerd/config.toml
```

#### 4.3 所有节点：安装 kubeadm / kubelet / kubectl

```bash
apt install -y apt-transport-https ca-certificates curl gpg
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.30/deb/Release.key \
 | gpg --dearmor -o /etc/apt/keyrings/k8s.gpg
echo 'deb [signed-by=/etc/apt/keyrings/k8s.gpg] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /' \
 >/etc/apt/sources.list.d/k8s.list
apt update && apt install -y kubelet kubeadm kubectl
apt-mark hold kubelet kubeadm kubectl
```

`apt-mark hold` 很重要：不锁定版本，一次 `apt upgrade` 就可能把 kubelet 升到与集群不兼容的版本。

#### 4.4 控制面：初始化

```bash
kubeadm init \
  --apiserver-advertise-address=192.168.56.11 \
  --pod-network-cidr=10.244.0.0/16 \
  --cri-socket=unix:///run/containerd/containerd.sock
```

成功后会输出 join 命令，**立刻保存**（token 24 小时过期，可用 `kubeadm token create --print-join-command` 重新生成）。

```bash
mkdir -p $HOME/.kube
cp /etc/kubernetes/admin.conf $HOME/.kube/config
chown $(id -u):$(id -g) $HOME/.kube/config
```

#### 4.5 控制面：装 CNI

```bash
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.0/manifests/calico.yaml
kubectl -n kube-system get pod -w
```

等 `calico-node`、`calico-kube-controllers` 都 Running，且节点状态从 `NotReady` 变 `Ready`。

#### 4.6 工作节点：加入

```bash
kubeadm join 192.168.56.11:6443 --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash>
```

### 五、验证

#### 5.1 集群状态

```bash
kubectl get nodes -o wide
kubectl get cs            # 1.27+ 已移除该命令，用下面的替代
kubectl -n kube-system get pod
```

#### 5.2 调度与网络

```bash
kubectl create deploy web --image=nginx --replicas=3
kubectl get pod -o wide -w        # 观察 3 个 Pod 分散到两个 worker
kubectl exec -it deploy/web -- curl -s http://web/ | head -3
```

跨节点 Pod 互通是 CNI 生效的关键证据。

#### 5.3 DNS

```bash
kubectl run dns --image=busybox:1.36 --rm -it --restart=Never -- \
  nslookup kubernetes.default
```

返回 `10.96.0.1` 说明 CoreDNS 正常。

#### 5.4 存储

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: t }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Gi } }
EOF
kubectl get pvc t
```

`Pending` 是正常的（没有默认 StorageClass）。装上 local-path-provisioner 或 NFS 后再验证 Bound。

### 六、注意事项

1. **时间必须同步**，时间漂移会导致证书校验失败、etcd 异常。
2. **节点间端口**：6443（API）、2379-2380（etcd）、10250（kubelet）、179（Calico BGP）、4789（VXLAN）。
3. **不要改 pod 网段**：初始化后改 `--pod-network-cidr` 需要重建集群。
4. **单控制面不是生产架构**：要 HA 需 3 个 control-plane + 外部 etcd 或 stacked etcd。
5. **不要把 worker 的 taint 去掉后调度系统组件**，容易把节点压死。

### 七、常见失败与定位

| 现象 | 原因 | 定位命令 |
| --- | --- | --- |
| 节点 NotReady | CNI 未就绪 / kubelet 未连上 | `journalctl -u kubelet -n 50` |
| join 失败 token 过期 | token 24h 失效 | `kubeadm token create --print-join-command` |
| Pod 一直 ContainerCreating | CNI 或镜像拉取失败 | `kubectl describe pod` 看 Events |
| cgroup 报错 | containerd 未用 systemd 驱动 | 检查 config.toml |
| API 6443 连不上 | 防火墙 / advertise 地址错 | `ss -lntp \| grep 6443` |

### 八、总结

这套集群的关键不是"跑起来了"，而是**每一步都有验证**：模块加载、转发开启、cgroup 驱动、CNI 生效、DNS 解析。任何一步跳过，故障都会延后到某个不相干的时间点爆发。

生产化的差距在于：HA 控制面、外部 etcd、节点池与污点、备份与升级流程、监控与告警。这些是"能跑"到"能负责"的距离。

### 九、附录：一键脚本

```bash
#!/usr/bin/env bash
# prep.sh —— 所有节点执行
set -euo pipefail
swapoff -a || true
sed -i '/ swap / s/^/#/' /etc/fstab
printf 'overlay\nbr_netfilter\n' >/etc/modules-load.d/k8s.conf
modprobe overlay; modprobe br_netfilter
cat >/etc/sysctl.d/k8s.conf <<'EOF'
net.bridge.bridge-nf-call-iptables=1
net.bridge.bridge-nf-call-ip6tables=1
net.ipv4.ip_forward=1
EOF
sysctl --system
apt-get update && apt-get install -y containerd apt-transport-https ca-certificates curl gpg
mkdir -p /etc/containerd
containerd config default >/etc/containerd/config.toml
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
systemctl enable --now containerd
echo "prep done: $(hostname)"
```
