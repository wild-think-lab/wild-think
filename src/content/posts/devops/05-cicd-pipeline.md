---
title: CI/CD 流水线：从"能跑通"到"敢上线"
description: 一条流水线的七个阶段、GitLab CI 与 Jenkins 的结构差异、缓存与并发怎么配、制品与回滚、以及"流水线慢"的五个常见原因。
date: 2026-11-27
tags: [CI/CD, GitLab, Jenkins, DevOps, 自动化]
---

### 流水线不是"自动 build"

一条能上线的流水线至少要覆盖七件事：

1. **触发**：push、MR、tag、定时。
2. **静态检查**：lint、格式、依赖漏洞扫描。
3. **构建**：编译、打包镜像。
4. **测试**：单测、集成测。
5. **制品**：推镜像仓库，打不可变 tag（commit sha，不用 `latest`）。
6. **部署**：按环境分批，能一键回滚。
7. **反馈**：失败通知到人，日志可查。

缺了 5 和 6，那叫"自动构建"，不叫 CI/CD。

### GitLab CI：stage 就是顺序

```yaml
stages: [check, build, test, package, deploy]

variables:
  IMAGE: registry.example.com/team/app
  TAG: $CI_COMMIT_SHORT_SHA

lint:
  stage: check
  image: golang:1.24-alpine
  script:
    - go vet ./...
    - test -z "$(gofmt -l .)" || (gofmt -l . && exit 1)
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

build:
  stage: build
  image: golang:1.24-alpine
  cache:
    key: go-$CI_COMMIT_REF_SLUG
    paths: [.cache/go]
  variables:
    GOCACHE: $CI_PROJECT_DIR/.cache/go
  script:
    - CGO_ENABLED=0 go build -o out/app ./cmd/server
  artifacts:
    paths: [out/app]
    expire_in: 1 week

test:
  stage: test
  needs: [build]
  script:
    - go test -race -coverprofile=cover.out ./...
  coverage: '/total:\s+(\d+\.\d+)%/'

package:
  stage: package
  image: docker:27
  services: [docker:27-dind]
  script:
    - docker build -t $IMAGE:$TAG .
    - docker push $IMAGE:$TAG
  rules:
    - if: $CI_COMMIT_BRANCH == "main"

deploy_prod:
  stage: deploy
  environment: production
  script:
    - kubectl set image deploy/app app=$IMAGE:$TAG
    - kubectl rollout status deploy/app --timeout=120s
  when: manual          # 生产必须人工点一下
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

三个细节值得说：

- `needs` 让 DAG 生效，test 不必等无关 job，整体能快 30%+。
- `cache` 与 `artifacts` 是两回事：cache 是"跨流水线复用依赖"，artifacts 是"本次阶段间传产物"。用错会既慢又乱。
- `when: manual` 用在生产部署，既是安全阀也是"变更留痕"。

### Jenkins：声明式 pipeline 的骨架

```groovy
pipeline {
  agent { label 'linux && docker' }
  options { timestamps(); timeout(time: 30, unit: 'MINUTES'); buildDiscarder(logRotator(numToKeepStr: '30')) }
  environment { IMAGE = "registry.example.com/team/app" }

  stages {
    stage('Checkout') { steps { checkout scm } }
    stage('Build') {
      steps { sh 'CGO_ENABLED=0 go build -o out/app ./cmd/server' }
    }
    stage('Test') {
      steps { sh 'go test -race ./...' }
      post { always { junit 'reports/*.xml' } }
    }
    stage('Package') {
      when { branch 'main' }
      steps {
        sh "docker build -t $IMAGE:${env.GIT_COMMIT.take(7)} ."
        sh "docker push $IMAGE:${env.GIT_COMMIT.take(7)}"
      }
    }
    stage('Deploy') {
      when { branch 'main' }
      steps { input '确认部署到生产？'; sh 'kubectl set image deploy/app app=$IMAGE:${GIT_COMMIT:0:7}' }
    }
  }
  post {
    failure { slackSend channel: '#build', message: "构建失败: ${env.JOB_NAME} #${env.BUILD_NUMBER}" }
  }
}
```

Jenkins 的优势是"什么都能做"，代价是所有东西都要自己维护：插件版本、节点、凭据、清理。**没有专人维护的 Jenkins 两年后一定变成祖传黑盒。**

### 流水线为什么慢

按影响排序：

1. **每次重下依赖**。缓存 key 用了 `$CI_COMMIT_SHA` 等于没缓存——key 应该按 lock 文件哈希（`go.sum`、`package-lock.json`）。
2. **串行执行**。测试、lint、安全扫描本可以并行。
3. **镜像构建没分层**。`COPY . .` 在 `RUN npm ci` 之前，每次全量重装。
4. **runner 太少**。排队时间比构建时间还长，看 runner 的并发上限。
5. **拉镜像慢**。内网没有镜像缓存，每个 job 都从外网拉基础镜像。

测一遍就有数：`CI job 各阶段耗时` 一般 GitLab 面板直接给。

### 制品与回滚

- 镜像 tag 用 **commit sha**，不要 `latest`。`latest` 无法回答"线上到底跑的哪个版本"。
- 部署清单（k8s Deployment）里写死 digest 更好：`app@sha256:...`。
- 回滚必须是**一条命令**：

```bash
kubectl rollout undo deploy/app        # 上一版
kubectl rollout undo deploy/app --to-revision=3
```

数据库变更不能靠"回滚镜像"——迁移脚本要么可前向兼容，要么准备好 down 脚本。

### 流水线与分支模型

| 模型 | 触发 | 说明 |
| --- | --- | --- |
| trunk-based | 合入 main 即构建部署 | 需要强测试覆盖，小步快跑 |
| GitFlow | 分支多、发布分支 | 重，适合有版本发行的产品 |
| MR 即验证 | MR 阶段跑全量检查 | 最实用，merge 前就拦住问题 |

MR 阶段跑"lint + 单测 + 镜像构建（不推）"，main 阶段才推镜像并部署。这样既拦住问题，又不让未合并代码污染制品库。

### 一句话总结

好的流水线不是"自动化程度高"，而是**失败得快、失败得清楚、回滚得干净**。
