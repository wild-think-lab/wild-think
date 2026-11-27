---
title: 部署代码仓库与 CI 流水线（自建）
module: 进阶篇
summary: Gitea/GitLab 的选择、Runner 与流水线、制品与镜像仓库、五个"自建 CI 反而更慢"的原因。
minutes: 50
---

### 选型

| 方案 | 适合 |
| --- | --- |
| Gitea + Actions | 轻量、资源少 |
| GitLab CE | 功能全（含 CI/CD、Registry），吃内存 |
| Jenkins | 老牌、插件多，维护成本高 |

**判据**：10 人内小团队 → Gitea；需要完整 DevOps 平台 → GitLab。

### Gitea 最小部署（容器）

```bash
docker run -d --name gitea \
  -p 3000:3000 -p 222:22 \
  -v /data/gitea:/data \
  -v /etc/localtime:/etc/localtime:ro \
  gitea/gitea:1.22
```

**要点**：

```
① 数据目录必须挂出来（/data 含仓库与配置）
② SSH 端口避开宿主 22
③ 反向代理加 TLS + 大文件上传限制
```

### Runner（执行流水线的地方）

```bash
gitea act_runner register --instance http://git.example.com \
  --token <token> --name runner-1
gitea act_runner daemon
```

**要点**：

```
① Runner 权限很大 → 单独机器/容器隔离
② 并发数按核数设
③ 有缓存目录（依赖不重复下载）
```

### 流水线示例

```yaml
# .gitea/workflows/build.yml
name: build
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
      - run: npm run build
```

**关键**：把"测试/构建"做成流水线的一部分，而不是本地手动。

### 制品与镜像仓库

```
① 制品（tar/war）：放对象存储或 Nexus
② 镜像：registry（Harbor 有 UI/扫描/复制）
```

```bash
docker tag app:1.0 registry.example.com/app:1.0
docker push registry.example.com/app:1.0
```

```yaml
# Harbor 项目设为私有 + 漏洞扫描
```

**"用 latest 覆盖推"** → 无法回溯，回滚时不知道推的是哪版。

### 五个"自建 CI 反而更慢"

**① 无缓存**

```
每次全量下依赖 → 5 分钟起步
```

**② Runner 与生产同机**

```
构建把业务 CPU 抢光
```

**③ 串行任务**

```
lint → test → build 全串行，其实可并行
```

**④ 每次拉全量镜像**

```
基础镜像不复用
```

**⑤ 无并发限制**

```
10 个 push 同时构建 → 排队几小时
```

### 安全要点

```
① Runner 只给可信仓库（PR 可执行代码有风险）
② 凭据用 secret（不入库）
③ 镜像扫描后再推
④ 制品有签名/校验
```

### 检查清单

```
□ 数据目录挂载 + 备份
□ SSH 端口与反代配置正确
□ Runner 隔离（不与生产混）
□ 有依赖缓存
□ 流水线有 lint/test/build
□ 制品/镜像有唯一 tag
□ 镜像扫描
□ 凭据走 secret
□ 有并发与排队监控
□ 有构建失败通知
```
