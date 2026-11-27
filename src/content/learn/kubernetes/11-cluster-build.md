---
title: 第 11 章 · 自己装一个集群：kubeadm 从零到可用
module: 熟练篇
summary: 前置条件、初始化、加入节点、CNI 与存储、以及五个"初始化失败"的常见原因。
minutes: 55
---

### 前置条件（六项必查）

```
① 关闭 swap（或设 swappiness=0）
② 内核模块：overlay、br_netfilter
③ sysctl：ip_forward、bridge-nf-call-iptables
④ 时间同步（chrony）
⑤ 主机名唯一 + /etc/hosts（或 DNS 可解析）
⑥ 端口放通（6443/10250/2379-2380/8472 或 CNI 端口）
```

```bash
modprobe overlay && modprobe br_netfilter
cat > /etc/modules-load.d/k8s.conf <<'EOF'
overlay
br_netfilter
EOF

cat > /etc/sysctl.d/k8s.conf <<'EOF'
net.bridge.bridge-nf-call-iptables=1
net.bridge.bridge-nf-call-ip6tables=1
net.ipv4.ip_forward=1
EOF
sysctl --system
swapoff -a && sed -i '/swap/s/^/#/' /etc/fstab
```

### 装容器运行时与 kubeadm

```bash
# containerd（推荐）
apt-get install -y containerd
containerd config default > /etc/containerd/config.toml
# 关键：SystemdCgroup = true
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
systemctl restart containerd

# kubeadm/kubelet/kubectl（按官方源）
apt-get install -y kubelet kubeadm kubectl
apt-mark hold kubelet kubeadm kubectl
```

**`SystemdCgroup` 没开** → 资源限制与 systemd 集成会出问题。

### 初始化控制面

```bash
kubeadm init --control-plane-endpoint "k8s-api.example.com:6443" \
  --pod-network-cidr 10.244.0.0/16 \
  --upload-certs
```

```bash
mkdir -p $HOME/.kube
cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
```

### 装 CNI 与验证

```bash
kubectl apply -f https://raw.githubusercontent.com/flannel-io/flannel/master/Documentation/kube-flannel.yml
kubectl get nodes
kubectl get pods -A
```

**判据**：

```
节点 Ready
kube-system 全部 Running
CoreDNS 正常
```

### 加入工作节点

```bash
# 控制面生成
kubeadm token create --print-join-command
# 在 worker 上执行输出
```

### 单节点集群（实验用）

```bash
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
```

### 五个"初始化失败"

**① 端口/防火墙**

```
6443 不通 → join 卡住
```

**② 时间不同步**

```
证书校验失败（x509: certificate expired）
```

**③ 主机名/IP 不匹配**

```
--control-plane-endpoint 指向的地址不可达
```

**④ cgroup 驱动不一致**

```
docker 与 kubelet 用不同 cgroup 驱动 → 节点 NotReady
```

**⑤ 已有残留**

```
之前 init 过 → 要 kubeadm reset + 清理 CNI 配置
```

### 本章检查清单

```
□ swap 关闭
□ 内核模块与 sysctl 设置
□ 时间同步
□ 主机名/hosts 正确
□ 端口放通
□ containerd 用 SystemdCgroup
□ kubeadm 版本锁定（apt-mark hold）
□ CNI 已装且 Pod 正常
□ join 命令可复用（token 有效期）
□ 有 reset 与重装的流程
```
