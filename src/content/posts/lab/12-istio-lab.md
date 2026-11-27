---
title: 实验报告：用 kubeadm 搭一个能用的 Istio 实验环境
description: 从零到"两条服务互相调用 + 灰度 + 熔断"的完整实验，含节点规划、安装步骤、验证方法与五个必踩的坑。
date: 2023-11-19
tags: [实验, Istio, Kubernetes, 服务网格]
---

### 一、实验目的

1. 在单机/多机上搭出一个可用的 Istio 环境。
2. 验证三个能力：流量路由（按 header 分流）、熔断、可观测（拓扑图）。
3. 记录踩坑，形成可复用的步骤。

### 二、环境规划

| 角色 | 规格 | 说明 |
| --- | --- | --- |
| master | 2C 4G | 控制面 |
| worker | 4C 8G | 跑 Istio 与业务 |
| OS | Ubuntu 22.04 | 内核 ≥ 4.x |

**资源提醒**：

```
Istio 的控制面（istiod）约需 1–2GB 内存
注入 sidecar 后，每个 Pod 多约 100MB
→ 8G 的 worker 只适合跑几个业务 Pod
```

### 三、前置：K8s 集群

```bash
# 1. 关 swap、加载模块
swapoff -a
sed -i '/swap/d' /etc/fstab
modprobe br_netfilter
cat > /etc/sysctl.d/k8s.conf <<'EOF'
net.bridge.bridge-nf-call-iptables=1
net.ipv4.ip_forward=1
EOF
sysctl --system

# 2. 装容器运行时（containerd）
apt install -y containerd
mkdir -p /etc/containerd
containerd config default > /etc/containerd/config.toml
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
systemctl restart containerd

# 3. 装 kubeadm/kubelet/kubectl
apt install -y kubelet kubeadm kubectl
apt-mark hold kubelet kubeadm kubectl

# 4. 初始化
kubeadm init --pod-network-cidr=10.244.0.0/16

# 5. 配置 kubeconfig
mkdir -p $HOME/.kube
cp /etc/kubernetes/admin.conf $HOME/.kube/config

# 6. 装 CNI（Istio 需要 CNI 支持）
kubectl apply -f https://raw.githubusercontent.com/flannel-io/flannel/master/Documentation/kube-flannel.yml

# 7. 单机实验：允许 master 跑 Pod
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
```

**为什么强调 CNI**：Istio 的网络依赖 K8s 的 Pod 网络，CNI 没装好后面全会失败。

### 四、安装 Istio

```bash
# 1. 下载
curl -L https://istio.io/downloadIstio | sh -
cd istio-*/
export PATH=$PWD/bin:$PATH

# 2. 检查环境（会告诉你缺什么）
istioctl x precheck

# 3. 安装（demo profile 适合实验）
istioctl install --set profile=demo -y

# 4. 确认
kubectl get pods -n istio-system
# 应有 istiod、ingressgateway
```

**profile 的差别**：

```
demo     ：装得多，便于实验（含 ingressgateway）
default  ：生产基础
minimal  ：只装 istiod（自己管网关）
empty    ：什么都不装
```

**实验用 demo，生产用 default + 自定义**。

### 五、部署两个示例服务

```bash
kubectl create ns demo
kubectl label ns demo istio-injection=enabled

kubectl -n demo apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web, version: v1 }
    spec:
      containers:
      - name: web
        image: hashicorp/http-echo
        args: ["-text=hello from v1", "-listen=:8080"]
        ports:
        - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector: { app: web }
  ports:
  - port: 80
    targetPort: 8080
EOF

kubectl -n demo get pods
# 应看到每个 Pod 有 2 个容器（业务 + istio-proxy）
```

**验证注入成功**：

```bash
kubectl -n demo get pod -o jsonpath='{.items[0].spec.containers[*].name}'
# 输出应包含 istio-proxy
```

### 六、验证三个能力

**① 流量路由（按 header 分流到 v2）**

```bash
# 先起一个 v2
kubectl -n demo scale deploy web --replicas=1
# （为了区分，通常再建一个 v2 的 Deployment 并打上 version: v2 标签）

# 定义路由
kubectl -n demo apply -f - <<'EOF'
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: web
spec:
  hosts: [web]
  http:
  - match:
    - headers:
        x-version:
          exact: v2
    route:
    - destination:
        host: web
        subset: v2
  - route:
    - destination:
        host: web
        subset: v1
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: web
spec:
  host: web
  subsets:
  - name: v1
    labels: { version: v1 }
  - name: v2
    labels: { version: v2 }
EOF
```

**测试**：

```bash
kubectl -n demo run curl --rm -it --image=curlimages/curl -- \
  curl -s -H "x-version: v2" http://web/
# 应返回 v2 的文本
```

**② 熔断（连续错误后摘除）**

```bash
kubectl -n demo apply -f - <<'EOF'
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: web
spec:
  host: web
  trafficPolicy:
    outlierDetection:
      consecutive5xxErrors: 3
      interval: 10s
      baseEjectionTime: 30s
EOF
```

**验证**：把 v1 的 Pod 改成返回 500，连续 3 次后该实例会被摘除 30 秒。

**③ 可观测（拓扑图）**

```bash
kubectl -n demo run curl --rm -it --image=curlimages/curl -- \
  curl -s http://web/ >/dev/null

istioctl dashboard kiali
# 或端口转发后在浏览器打开
```

**Kiali 里能看到**：

```
服务之间的调用关系、请求量、错误率、延迟
```

### 七、五个必踩的坑

**① Pod 没有 sidecar**

```
原因：命名空间没打 istio-injection=enabled 标签（且 Pod 在打标签之前创建）
处理：打标签后重建 Pod（sidecar 在创建时注入）
```

**② 注入后启动失败（探针失败）**

```
原因：sidecar 启动比业务慢，或 readiness 探针在注入后行为变化
处理：给业务加启动宽限期（initialDelaySeconds）
```

**③ 出不了网**

```
原因：Istio 的 sidecar 拦截所有出站流量，未注册的外部服务被拦（REGISTRY_ONLY 模式）
处理：配置 ServiceEntry，或设 outboundTrafficPolicy.mode=ALLOW_ANY（仅实验）
```

**④ 端口/协议不对**

```
原因：Istio 只识别特定端口（如 80/443/8080）与协议
处理：非标准端口要显式声明（Service 的 ports 里写 name: http）
```

**⑤ 资源不足导致 istiod 反复重启**

```
原因：8G 单机同时跑 K8s + Istio + 业务
处理：至少 16G，或减少组件（用 minimal profile）
```

### 八、清理

```bash
istioctl uninstall --purge -y
kubectl delete ns istio-system demo
```

**`--purge`** 会删掉所有 Istio 相关 CRD 与配置（实验环境用，生产慎用）。

### 九、实验结论

```
① VirtualService + DestinationRule 是实现"路由 + 分组"的最小组合
② 熔断靠 DestinationRule 的 outlierDetection，不需要额外组件
③ Kiali 的价值在"看得见调用关系"，排障时很有用
④ 资源是最大的现实约束：Istio 不轻
```

**"该不该上 Istio"的判断**：

```
服务数 > 20 且有跨语言 → 有收益
服务数 < 10 且单一语言 → 用 SDK/框架内解决更省
```

### 附录：一键脚本

```bash
#!/usr/bin/env bash
set -euo pipefail
export PATH=$PWD/bin:$PATH
istioctl x precheck
istioctl install --set profile=demo -y
kubectl create ns demo || true
kubectl label ns demo istio-injection=enabled --overwrite
echo "ready. deploy your app into ns demo"
```
