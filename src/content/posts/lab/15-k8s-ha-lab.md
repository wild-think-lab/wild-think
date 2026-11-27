---
title: 实验报告：三节点 K8s 高可用集群从零搭建
description: 目的/环境/原理/步骤/验证/注意/总结/附录，含 etcd 三副本与 apiserver 负载均衡。
date: 2024-08-06
tags: [实验, Kubernetes, 高可用]
---

### 一、实验目的

```
① 理解"高可用"要解决哪三个单点（etcd/apiserver/控制面）
② 动手搭三节点堆叠 etcd + 多 apiserver
③ 验证：杀掉一个节点后集群仍可用
```

### 二、实验环境

| 主机 | IP | 角色 |
| --- | --- | --- |
| k8s-m1 | 10.0.2.11 | control-plane + etcd |
| k8s-m2 | 10.0.2.12 | control-plane + etcd |
| k8s-m3 | 10.0.2.13 | control-plane + etcd |
| vip | 10.0.2.10 | apiserver 负载均衡 VIP |

**规格**：4C8G，Rocky 9，kubeadm 1.29。

### 三、原理

```
① etcd 三副本（Raft）→ 容忍 1 台故障
② apiserver 无状态 → 多实例 + VIP/LB
③ controller-manager/scheduler → leader election（同时只有一个干活）
```

**"三节点堆叠 etcd"** 是最简单的 HA 方案（无需外部 etcd 集群）。

### 四、实验步骤

**1）前置（三台都做）**

```bash
# 关闭 swap
swapoff -a
sed -i '/swap/s/^/#/' /etc/fstab

# 内核模块
cat > /etc/modules-load.d/k8s.conf <<'EOF'
overlay
br_netfilter
EOF
modprobe overlay; modprobe br_netfilter

# 内核参数
cat > /etc/sysctl.d/k8s.conf <<'EOF'
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward = 1
EOF
sysctl -p /etc/sysctl.d/k8s.conf

# 时间同步
timedatectl set-ntp true
```

**2）装容器运行时（containerd）**

```bash
dnf install -y containerd
mkdir -p /etc/containerd
containerd config default > /etc/containerd/config.toml
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
systemctl enable --now containerd
```

**3）装 kubeadm/kubelet/kubectl**

```bash
cat > /etc/yum.repos.d/kubernetes.repo <<'EOF'
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/v1.29/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/v1.29/rpm/repodata/repomd.xml.key
EOF
dnf install -y kubelet kubeadm kubectl --disableexcludes=kubernetes
systemctl enable kubelet
```

**4）第一台 init（带 HA 参数）**

```bash
kubeadm init \
  --control-plane-endpoint "10.0.2.10:6443" \
  --upload-certs \
  --pod-network-cidr 10.244.0.0/16 \
  --apiserver-advertise-address 10.0.2.11
```

**输出里会有两条关键命令**：

```
kubeadm join 10.0.2.10:6443 --token ... --discovery-token-ca-cert-hash ...
kubeadm join 10.0.2.10:6443 --token ... --control-plane --certificate-key ...
```

**5）其余两台加入**

```bash
# m2/m3 作为 control-plane
kubeadm join 10.0.2.10:6443 --token <t> --discovery-token-ca-cert-hash <h> \
  --control-plane --certificate-key <k>
```

**6）装 CNI**

```bash
kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml
kubectl get nodes -w
```

**7）VIP 负载均衡（haproxy + keepalived）**

```conf
# /etc/haproxy/haproxy.cfg
frontend apiserver
  bind *:6443
  mode tcp
  default_backend apiservers
backend apiservers
  mode tcp
  server m1 10.0.2.11:6443 check
  server m2 10.0.2.12:6443 check
  server m3 10.0.2.13:6443 check
```

**"VIP 是单点"** → keepalived 做 VIP 漂移（本实验用单 VIP 简化）。

### 五、验证

**1）集群状态**

```bash
kubectl get nodes -o wide
kubectl get --raw /healthz
etcdctl --endpoints=https://10.0.2.11:2379,https://10.0.2.12:2379,https://10.0.2.13:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key endpoint status -w table
```

**2）高可用验证（关键）**

```bash
# 关掉 m1
ssh k8s-m1 'systemctl stop kubelet'
# 集群仍可读写
kubectl get nodes
kubectl create ns ha-test
kubectl -n ha-test run nginx --image=nginx
```

**"关掉一台后 `kubectl` 仍可用"** = apiserver/etcd 够用。

**3）etcd 三副本**

```
3 台 endpoint status 显示 3 个成员，1 个 leader，2 个 follower
```

### 六、注意

```
① 三节点是"最小可容忍 1 台故障"的配置（2 节点不加权）
② VIP 必须由 keepalived 管理（否则单点）
③ 证书 2 年/10 年（1.29 起证书有效期更长，但要规划更新）
④ kubeadm join 的 token 24 小时过期（过期用 create-token 重生成）
```

```bash
kubeadm token create --print-join-command
kubeadm init phase upload-certs --upload-certs     # 重新生成 certificate-key
```

### 七、总结

```
① HA 的三个点：etcd、apiserver、VIP
② 堆叠 etcd 够用（不必外部 etcd）
③ leader election 让 controller/scheduler 无冲突
④ 验证"杀一台仍可用"才算真的 HA
```

### 八、附录：常见报错

| 报错 | 原因 |
| --- | --- |
| `[ERROR Swap]` | 没关 swap |
| `br_netfilter not loaded` | 模块未加载 |
| `cri-dockerd` 相关 | 用了 docker 没装 shim |
| join 超时 | VIP/端口不通，或 token 过期 |
| `etcd cluster not healthy` | 时间不同步/证书过期 | 
