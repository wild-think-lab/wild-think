---
title: GitLab CI 从零到可用：一份能直接抄的流水线
description: 从 .gitlab-ci.yml 的最小可用版本，到缓存、并行、制品、环境与手动审批，附十个常见报错。
date: 2024-12-30
tags: [GitLab CI, CI/CD, 流水线]
---

### 最小可用版本

```yaml
stages:
- build
- test
- deploy

build:
  stage: build
  image: node:20
  script:
  - npm ci
  - npm run build
  artifacts:
    paths:
    - dist/
    expire_in: 1 week

test:
  stage: test
  image: node:20
  script:
  - npm ci
  - npm test -- --ci

deploy:
  stage: deploy
  image: alpine:3.19
  script:
  - apk add --no-cache openssh-client rsync
  - eval $(ssh-agent -s)
  - echo "$SSH_PRIVATE_KEY" | ssh-add -
  - mkdir -p ~/.ssh && ssh-keyscan -H "$DEPLOY_HOST" >> ~/.ssh/known_hosts
  - rsync -az --delete dist/ "$DEPLOY_USER@$DEPLOY_HOST:/srv/app/"
  only:
  - main
```

**三个关键点**：

```
① artifacts 把产物传给后续 job（不重复构建）
② only: main 让部署只在主分支跑
③ 密钥放在 CI/CD Variables（不要在 yaml 里）
```

### 缓存 vs 制品

```
cache     同一 job 在不同流水线之间复用（如 node_modules）
artifacts 同一流水线内 job 之间传递（如 dist、测试报告）
```

```yaml
# 缓存依赖（加速安装）
cache:
  key:
    files:
    - package-lock.json          # lock 变了缓存就失效
  paths:
  - node_modules/
```

**`cache:key:files`** 很重要：不写的话，依赖变了但缓存还是旧的，会出诡异问题。

### 并行与矩阵

```yaml
test:
  stage: test
  parallel: 4                       # 跑 4 个副本
  script:
  - npm ci
  - npx jest --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL

# 或按不同版本/环境
lint:
  parallel:
    matrix:
    - NODE_VERSION: ["18", "20", "22"]
  image: node:$NODE_VERSION
  script:
  - npm ci && npm run lint
```

**`parallel: 4` 的收益**：测试从 4 分钟降到 1 分多（前提是测试能分片）。

### 环境与手动审批

```yaml
deploy:staging:
  stage: deploy
  environment:
    name: staging
    url: https://staging.example.com
  script:
  - ./deploy.sh staging
  only: [main]

deploy:prod:
  stage: deploy
  environment:
    name: production
    url: https://example.com
  script:
  - ./deploy.sh production
  when: manual                    # 手动点按钮
  allow_failure: false            # 手动任务不能"跳过"
  only: [main]
```

**`when: manual` + `environment: production`** 是"生产发布要点按钮"的标准做法。

GitLab 的 Environment 还会记录"哪个版本部署到了哪个环境"，回滚时有据可查。

### 完整的可抄版本（带规则）

```yaml
workflow:
  rules:
  - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  - if: '$CI_COMMIT_BRANCH == "main"'
  - if: '$CI_COMMIT_TAG'

default:
  image: node:20
  cache:
    key:
      files: [package-lock.json]
    paths: [node_modules/]
  before_script:
  - npm ci --prefer-offline

stages:
- lint
- test
- build
- deploy

lint:
  stage: lint
  script: [npm run lint]

unit:
  stage: test
  script: [npm run test:unit]
  coverage: '/All files[^|]*\|[^|]*\s+([\d\.]+)/'
  artifacts:
    when: always
    reports:
      junit: reports/junit.xml
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml

build:
  stage: build
  needs: [lint, unit]
  script: [npm run build]
  artifacts:
    paths: [dist/]
    expire_in: 1 week

deploy:prod:
  stage: deploy
  needs: [build]
  environment:
    name: production
    url: https://example.com
  script: [./ci/deploy.sh]
  rules:
  - if: '$CI_COMMIT_TAG'
    when: manual
```

**`needs`** 让 job 不用等整个 stage 完成，直接依赖具体 job → 流水线更快。

### 十个常见报错

**① `This job is stuck because you don't have any runners online`**

```
原因：没有可用的 Runner 或 tag 不匹配
处理：检查 Runner 的 tag 与 job 的 tags 是否一致
```

**② `Permission denied (publickey)`**

```
原因：SSH 私钥格式或 known_hosts 问题
处理：私钥要用"原文"（含 BEGIN/END 行），不要 base64
```

**③ `npm ci` 报 lock 文件不同步**

```
原因：package.json 改了但 lock 没更新
处理：本地 npm install 后提交 lock
```

**④ 缓存没生效**

```
原因：cache:key 没写 files，或 Runner 是 docker executor 且没配 volume
处理：加 cache:key:files；Runner 配 /cache 目录
```

**⑤ 制品太大导致上传慢**

```
处理：只传必要文件（dist 而不是整个仓库），加 expire_in
```

**⑥ `rules` 与 `only` 混用**

```
❌ 同时写 only/except 和 rules → 报错或行为诡异
✅ 只用一个（新版推荐 rules）
```

**⑦ 变量里带特殊字符导致 shell 报错**

```
处理：用引号包裹 "$VAR"，或在变量设置里标记为"masked"
```

**⑧ MR 流水线重复跑**

```
原因：push 到分支 + 开 MR → 两条流水线
处理：workflow:rules 里排除 branch pipeline（只保留 MR）
```

**⑨ 部署脚本没有执行权限**

```
处理：script 里 chmod +x，或直接 bash ./deploy.sh
```

**⑩ 超时**

```
默认 job 超时 60 分钟（可项目设置里改）
处理：拆分长 job，或用 needs 并行
```

### 安全检查清单

```
□ 密钥放 CI/CD Variables（masked + protected）
□ protected 变量只对 protected 分支可用
□ 部署 job 用 environment（可追溯）
□ 生产部署 when: manual
□ 不在 yaml 里 echo 密钥
□ Runner 的 executor 权限受限（docker executor，不用 shell executor 跑公网项目）
□ 第三方镜像固定 digest 或版本
```

**`protected` 变量的意义**：只有受保护分支（如 main）才能读到，避免"任何分支都能拿到生产密钥"。

### 检查清单

```
□ 有 cache（含 key:files）
□ 有 artifacts（build 传给 deploy）
□ 部署只在 main/tag
□ 生产手动审批
□ 用 needs 缩短流水线
□ 测试有覆盖率与 junit 报告
□ 变量设 masked + protected
□ 不混用 rules 与 only
□ 镜像固定版本而非 latest
```
