---
title: 部署自动化平台：AWX 与作业标准化
module: 进阶篇
summary: AWX Operator 部署、Project 与 Inventory、凭据管理、作业模板与调度，五个"自动化平台变成手工平台"的原因。
minutes: 45
---

## 一、先弄懂它是什么

**AWX 是 Ansible 的"运行平台"：把 playbook、主机清单、凭据集中管理，并把每次执行变成可审计的作业。**

```
Git 仓库（playbook） ┐
Inventory（主机）    ├→ 作业模板 → 执行容器（EE） → 目标主机
Credential（凭据）   ┘             ↑ 日志/结果全留痕
```

**它解决的问题**：Ansible 本身只是"能跑 playbook 的工具"，问题是——谁跑了、跑在哪、用了什么密码、结果如何。这些在个人电脑上全是空白。AWX 把这三件事变成平台的职责。

### Ansible 的原理（先懂这个，才能用好平台）

```
① 无代理（agentless）：靠 SSH/WinRM 连目标机，不需要装客户端
② 幂等（idempotent）：同一个 playbook 跑多次结果一致（用模块而不是 shell）
③ 声明式：写"应该是什么样"，不写"一步步怎么做"
④ 按清单并行：forks 决定并发数，serial 决定每批多少台
```

**判据**：如果你写的任务全是 `shell:`，那只是"远程执行脚本"，享受不到幂等与差异检查。

### 平台里的四个核心对象

| 对象 | 作用 | 常见错误 |
| --- | --- | --- |
| Credential | SSH 私钥/密码/Vault 密码，加密存储 | 密码直接写进 playbook |
| Inventory | 主机清单，支持分组与组变量 | 主机名解析不了、变量放错层级 |
| Project | 指向 Git 仓库的 playbook 集合 | 手动改服务器上的文件，Git 不同步 |
| Job Template | 凭据 + 清单 + playbook = 一次可执行作业 | 一个模板塞太多分支 |

### 执行容器（EE）的意义

```
EE = 装着 ansible + 依赖 + 集合的镜像
→ 执行环境可复现，不会"在我机器上能跑"
```

### 权限模型（为什么平台比脚本安全）

```
组织（Organization）→ 用户/团队 → 角色（Admin/Execute/Read）
资源（凭据/清单/项目/模板）按角色授权
→ 能执行某作业，不代表能看它的凭据
```

### 什么情况值得上平台

```
值得：机器 > 30 台、多人运维、需要审计与定时
不值得：3 台机器、一个人维护（直接 ansible-playbook 更省事）
```

### 为什么要有平台

```
① 谁在什么时候对哪些机器执行了什么（审计）
② 凭据集中在平台（不落个人电脑）
③ 作业可重复、可回滚、可定时
```

**"脚本在个人目录里"** → 人一走就失传，也没人知道跑过什么。

### 部署（k3s + AWX Operator）

```bash
curl -sfL https://get.k3s.io | sh -
kubectl get nodes
```

```yaml
# awx.yml
apiVersion: awx.ansible.com/v1beta1
kind: AWX
metadata: { name: awx }
spec:
  service_type: clusterip
  ingress_type: none
```

```bash
kubectl apply -f awx.yml
kubectl get pods -n awx -w
```

**访问**：默认在 8043（NodePort）或通过反代；初始 admin 密码在 secret 里。

```bash
kubectl get secret awx-admin-password -n awx -o jsonpath='{.data.password}' | base64 -d
```

### 四个核心对象

```
Credential（凭据：SSH 私钥/密码/vault）
Inventory（主机清单，可分组）
Project（Git 仓库里的 playbook）
Job Template（凭据 + 清单 + playbook = 一次可执行作业）
```

**判据**：一次作业 = 一个模板，不要在模板里塞"条件分支全靠变量"。

### 凭据管理

```
① SSH 私钥存为 Credential（加密存储）
② 敏感变量用 Vault（Ansible Vault）
③ 按团队分配权限（谁能用哪个凭据）
④ 定期轮换
```

**"密码写在 playbook 里"** → Git 里永久留痕。

### 作业模板与调度

```yaml
# 一个标准作业：滚动重启服务
- hosts: app
  serial: 1
  tasks:
    - name: drain
      shell: systemctl stop app
    - name: wait healthy
      uri: { url: "http://127.0.0.1:8080/healthz", status_code: 200 }
      retries: 10
      delay: 3
    - name: start
      systemd: { name: app, state: started }
```

**要点**：`serial: 1` 保证逐台，失败即停。

### 五个"平台变手工"

**① 只有人能点，没有调度**

```
该定时的没定时，还是人工触发
```

**② playbook 直接改生产不备份**

```
失败无回滚
```

**③ 凭据权限没分级**

```
谁都能对全网执行
```

**④ 作业没有审批**

```
高危作业（删库/重启网关）可直接跑
```

**⑤ 执行日志不保留**

```
出事查不到是哪次作业引起的
```

### 五个"作业跑失败"

```
① Inventory 主机名解析不了
② SSH 用户无 sudo 权限
③ Python 解释器缺失（ansible_python_interpreter）
④ 并发太高被目标机限流
⑤ 凭据过期（密码轮换后未更新）
```

### 检查清单

```
□ 平台化部署（k8s/operator）
□ 凭据集中且加密
□ 权限按团队分级
□ 高危作业有审批
□ 有定时调度
□ 作业有 serial 与健康检查
□ 失败即停 + 有回滚
□ 执行日志可查（谁/何时/结果）
□ 有 Inventory 分组与变量
□ 凭据轮换流程
```
