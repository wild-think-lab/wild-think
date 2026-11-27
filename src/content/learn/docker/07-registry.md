---
title: 镜像仓库：从 docker push 到私有 Harbor
module: 熟练篇
summary: Registry 与镜像命名、私有仓库搭建与登录、多架构构建、漏洞扫描与保留策略。
minutes: 45
---

### 命名规则（很多人卡在这里）

```
<registry>/<namespace>/<repo>:<tag>
docker.io/library/nginx:1.25
harbor.example.com/app/api:1.4.2
```

**要点**：

```
① 不写 registry → 默认 docker.io
② 私有仓库必须写全域名（含端口）
③ tag 要可追溯（版本号 + git sha），不要只用 latest
```

### 推送到私有仓库

```bash
docker login harbor.example.com -u deploy -p "$TOKEN"
docker tag api:1.4.2 harbor.example.com/app/api:1.4.2
docker push harbor.example.com/app/api:1.4.2
```

**"push 报 401"** → 先 `docker login`，且注意凭据文件 `~/.docker/config.json` 权限。

### 自建最小 Registry（先跑通再谈 Harbor）

```bash
docker run -d --name registry -p 5000:5000 \
  -v /data/registry:/var/lib/registry \
  registry:2
```

```bash
# 不安全仓库（仅内网测试）
cat > /etc/docker/daemon.json <<'EOF'
{"insecure-registries":["10.0.0.5:5000"]}
EOF
systemctl restart docker
```

**生产必须上 TLS**（否则 push/pull 凭据明文）。

### Harbor：值得用的理由

```
① 项目/成员权限（RBAC）
② 镜像扫描（Trivy 集成）
③ 复制（多机房同步）
④ 保留策略（自动清理旧 tag）
⑤ 审计日志
```

### 多架构构建

```bash
docker buildx create --use --name multi
docker buildx build --platform linux/amd64,linux/arm64 \
  -t harbor.example.com/app/api:1.4.2 --push .
```

**"在 M 系列 Mac 上构建的镜像跑到 x86 服务器崩"** → 就是架构不对。

### 漏洞扫描

```bash
trivy image --severity HIGH,CRITICAL harbor.example.com/app/api:1.4.2
```

**判据**：

```
CRITICAL 必须修（或明确豁免并记录）
HIGH 排期修
```

### 保留策略

```
① 每个仓库保留最近 N 个 tag（如 20）
② 保留"生产在用的"（按部署记录反查）
③ 定期清理（否则存储爆）
```

**"只保留 latest"** 会导致无法回滚到上一个版本。

### 五个"镜像管理"的坑

**① latest 满地跑**

```
无法回滚、无法追溯（用 digest 部署更稳）
```

**② 仓库无认证**

```
内网谁都能 push → 投毒风险
```

**③ 存储无限增长**

```
没保留策略 → 半年后磁盘满
```

**④ 扫描只在 CI**

```
上线后基础镜像出了新 CVE → 没人管
```

**⑤ 跨机房同步靠人**

```
Harbor 复制规则可以自动化
```

### 检查清单

```
□ tag 含版本/commit，不只 latest
□ 私有仓库有认证 + TLS
□ 有 RBAC（谁能 push 哪个项目）
□ 多架构构建（如需要）
□ 有镜像扫描且高危阻断
□ 有保留策略（自动清理）
□ 生产部署按 digest
□ 有多机房复制（如需要）
□ 有审计日志
□ 定期重建基础镜像
```
