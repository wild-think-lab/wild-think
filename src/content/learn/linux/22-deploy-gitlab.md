---
title: 部署 GitLab CE：从安装到能跑流水线
module: 进阶篇
summary: 资源要求、外部地址配置、Runner 注册、备份与恢复、升级顺序，五个"装完不能 clone/push"的原因。
minutes: 50
---

## 一、先弄懂它是什么

**GitLab 不是"一个 Git 服务器"，它是一整套研发协作平台。**

| 层次 | 能力 | 依赖什么 |
| --- | --- | --- |
| 代码托管 | Git 仓库、SSH/HTTPS 克隆、保护分支 | Gitaly（Git 的 RPC 服务） |
| 协作 | Merge Request、Issue、Wiki、里程碑 | PostgreSQL |
| CI/CD | `.gitlab-ci.yml`、Runner、制品、环境 | Runner + 对象存储（制品） |
| 交付 | 容器镜像仓库、Pages、发布 | Registry、对象存储 |
| 治理 | 用户/组/项目权限、审计、合规 | 内部账号体系或 LDAP |

**它解决的核心问题**：把"代码—评审—构建—部署"的链路收敛到一处，并且**权限和审计有单一事实来源**。这正是它比"Git 裸仓库 + 自己写脚本"值钱的地方。

### 组件关系（看懂这个才能排障）

```
浏览器 → nginx（GitLab 内置）→ puma（Rails 应用）
                                    ├→ PostgreSQL（数据）
                                    ├→ Redis（缓存/队列）
                                    ├→ Gitaly（Git 读写）
                                    └→ Sidekiq（异步任务：流水线调度、邮件、备份）
```

**判据**：502 常见于 puma 未起或数据库不可用；push 卡住常见于 Gitaly;流水线不跑常见于 Sidekiq 挂了。

### 为什么它"吃资源"

```
Rails 单体应用 + 后台常驻进程（puma 多进程、Sidekiq 多线程）
再加 PostgreSQL、Redis、Gitaly
→ 4C8G 是"能启动"，8C16G 才是"能用"
```

这不是配置没优化，是架构决定的。小团队想省资源，要么用 Gitea，要么把 GitLab 拆到独立机器。

### 三个容易误解的点

```
① GitLab 的"备份"不等于"复制数据目录"：必须用 gitlab-backup（含数据库、仓库、制品的一致性快照）
② gitlab.rb 与 gitlab-secrets.json 是两套东西：前者是配置，后者是加密密钥，丢了 CI 变量/2FA 全废
③ external_url 是"身份"：它决定 clone 地址、OAuth 回调、邮件链接，改它等于搬家
```

### 什么情况适合自建

```
适合：需要内网代码托管、要自建 CI/CD、合规要求代码不出内网
不适合：三五个人只要 Git 仓库（Gitea 更轻）、只需要镜像仓库（Harbor 就够）
```

### 选型对照

| 方案 | 资源 | 能力 | 适合 |
| --- | --- | --- | --- |
| Gitea | 1C2G 可跑 | 仓库 + 轻量 Actions | 小团队、内网 |
| GitLab CE | 8C16G 起 | 全流程 DevOps | 中大型团队 |
| Jenkins + 裸 Git | 中等 | 只解决构建 | 已有体系，补 CI |

### 先看清资源

```
最低：4 核 8G（跑起来卡）
推荐：8 核 16G + SSD，带 CI 再加
```

**"2C4G 装 GitLab"** → 整天 502，体验极差。

### 安装（容器方式）

```bash
docker run -d --name gitlab \
  --hostname git.example.com \
  -p 443:443 -p 80:80 -p 22:22 \
  -v /data/gitlab/config:/etc/gitlab \
  -v /data/gitlab/logs:/var/log/gitlab \
  -v /data/gitlab/data:/var/opt/gitlab \
  --shm-size 256m \
  gitlab/gitlab-ce:17.4
```

**要点**：

```
① 三个目录必须挂出来（升级/迁移全靠它）
② --shm-size（默认 64m 会导致异常）
③ hostname 决定 clone 地址
```

### 外部地址（改错了 clone 就废）

```ruby
# /etc/gitlab/gitlab.rb
external_url 'https://git.example.com'
nginx['listen_port'] = 80
gitlab_rails['gitlab_ssh_host'] = 'git.example.com'
gitlab_rails['gitlab_shell_ssh_port'] = 22
```

```bash
gitlab-ctl reconfigure
```

**判据**：`gitlab.rb` 的 external_url 与 SSH 端口要和实际访问一致，否则 clone 地址错。

### 五个"装完不能 clone/push"

**① SSH 端口不一致**

```
显示 git@host:repo.git 但 SSH 在 2222
```

**② 反向代理没透传**

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
client_max_body_size 0;      # GitLab 需要
```

**③ 大仓库 push 413**

```
client_max_body_size 太小
```

**④ 时钟不准**

```
TLS/Token 校验失败
```

**⑤ 磁盘满 → 只读**

```
GitLab 会进入维护模式，push 全失败
```

### Runner 注册

```bash
docker run -d --name runner \
  -v /data/runner:/etc/gitlab-runner \
  -v /var/run/docker.sock:/var/run/docker.sock \
  gitlab/gitlab-runner:latest

docker exec -it runner gitlab-runner register \
  --url https://git.example.com \
  --token <runner-token> \
  --executor docker \
  --docker-image alpine:latest
```

**注意**：挂 `docker.sock` 等于给 Runner 宿主权限，务必隔离机器。

### 备份与恢复

```ruby
gitlab_rails['backup_path'] = '/var/opt/gitlab/backups'
gitlab_rails['backup_keep_time'] = 604800
```

```bash
gitlab-backup create
# 恢复（同版本！）
gitlab-ctl stop puma && gitlab-ctl stop sidekiq
gitlab-backup restore BACKUP=<timestamp>
gitlab-ctl reconfigure && gitlab-ctl restart
```

**关键**：恢复必须**同版本**；`/etc/gitlab/gitlab.rb` 和 `gitlab-secrets.json` 要单独备份。

**"只备份了备份包"** → secrets 丢了，2FA/CI 变量全部失效。

### 升级顺序

```
① 先备份 → ② 小版本逐级升（不能跨大版本）
③ reconfigure → ④ 验证 clone/push/流水线
```

### 检查清单

```
□ 资源达标（≥8C16G）
□ 三目录持久化
□ external_url / SSH 端口一致
□ 反代透传 Host 与 Proto
□ client_max_body_size 已放大
□ NTP 正常
□ 磁盘水位告警
□ Runner 隔离（不和生产混）
□ 备份含 gitlab.rb + secrets
□ 升级逐级且先备份
```
