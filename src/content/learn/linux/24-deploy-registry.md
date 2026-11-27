---
title: 部署镜像仓库：Harbor 与镜像治理
module: 进阶篇
summary: Harbor 安装与 HTTPS、项目与机器人账号、复制与扫描、GC 与配额，五个"仓库越用越乱"的原因。
minutes: 45
---

### 为什么自建 registry

```
① 内网构建/拉取快
② 镜像不外流（合规）
③ 有 UI/权限/扫描/复制
```

### 安装（离线包最稳）

```bash
tar -xzf harbor-offline-installer-*.tgz -C /opt
cd /opt/harbor
cp harbor.yml.tmpl harbor.yml
```

```yaml
hostname: registry.example.com
https:
  port: 443
  certificate: /opt/harbor/certs/registry.crt
  private_key: /opt/harbor/certs/registry.key
harbor_admin_password: <强密码>
data_volume: /data/harbor
trivy:
  ignore_unfixed: false
```

```bash
./install.sh --with-trivy
```

**要点**：必须配 HTTPS（docker 默认拒绝非安全 registry，除非改 daemon 配置）。

### 项目与权限

```
① 每个团队一个项目
② 项目设为私有
③ 机器人账号（CI 用）+ 只给 push/pull
④ 保留"公开只读"项目给基础镜像
```

```bash
docker login registry.example.com -u robot-ci -p ***
docker tag app:1.0 registry.example.com/team-a/app:1.0
docker push registry.example.com/team-a/app:1.0
```

### 镜像治理三件事

```
① 不可变 tag（按 commit/版本），禁 latest
② 保留策略（保留最近 N 个 + 重要 tag）
③ 垃圾回收（GC）释放被删镜像的层
```

```bash
# 保留策略：项目 → Policy → 保留最近 10 个
# GC 需要在维护窗口执行
docker-compose -f /opt/harbor/docker-compose.yml stop
# 通过 UI 或 API 触发 GC
```

**"只删 tag 不 GC"** → 磁盘空间一点没释放。

### 复制（多集群分发）

```
① 新建"复制规则"：源项目 → 目标 registry
② 触发方式：手动 / 定时 / 事件（push 即复制）
③ 用于异地灾备或多集群分发
```

### 五个"越用越乱"

**① 全用 latest**

```
回滚时不知道推的是哪版
```

**② 没有保留策略**

```
几年后几个 TB，GC 也救不回来
```

**③ 磁盘满**

```
push 失败，CI 全线红
```

**④ 扫描只报不拦**

```
高危镜像照样上线
```

**⑤ 凭据写进 CI 明文**

```
仓库账号泄露 → 镜像被投毒
```

### 五个"push 失败"

```
① HTTPS 证书不受信（用内部 CA 需分发）
② 项目是私有的但账号无权限
③ 磁盘配额/水位满
④ 镜像太大超单层限制
⑤ 系统时钟偏差导致 token 失效
```

### 检查清单

```
□ HTTPS + 证书受信
□ 项目私有 + 团队隔离
□ CI 用机器人账号（最小权限）
□ 禁止 latest（规范 + 校验）
□ 有保留策略
□ 定期 GC
□ 磁盘水位告警
□ 扫描高危阻断
□ 有复制（异地/多集群）
□ 有镜像签名/来源校验
```
