---
title: Jenkins 流水线：把 Jenkinsfile 写成别人能接手的样子
description: 声明式流水线的结构、并行与超时的正确用法、凭据管理、共享库该抽什么，以及"流水线越来越慢"的四个真实原因。
date: 2023-04-23
tags: [Jenkins, CI, 流水线, DevOps]
---

### 一条能长期维护的 Jenkinsfile

```groovy
pipeline {
  agent { label 'docker && linux' }
  options {
    timestamps()
    timeout(time: 30, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '10'))
    disableConcurrentBuilds()          // 同一分支不并行
  }
  parameters {
    choice(name: 'ENV', choices: ['dev','staging','prod'], description: '目标环境')
    booleanParam(name: 'SKIP_TEST', defaultValue: false, description: '跳过单测（紧急发布）')
  }
  environment {
    IMAGE = "registry.example.com/order-svc"
    TAG  = "${env.GIT_COMMIT.take(7)}"
  }
  stages {
    stage('Checkout') { steps { checkout scm } }
    stage('Build') {
      steps { sh 'make build' }
    }
    stage('Test') {
      when { expression { !params.SKIP_TEST } }
      parallel {
        stage('Unit')  { steps { sh 'make test-unit' } }
        stage('Lint')  { steps { sh 'make lint' } }
        stage('Static'){ steps { sh 'make vet' } }
      }
      post {
        always { junit 'reports/**/*.xml' }
      }
    }
    stage('Image') {
      steps {
        withCredentials([usernamePassword(credentialsId: 'registry', usernameVariable: 'RU', passwordVariable: 'RP')]) {
          sh '''
            echo "$RP" | docker login registry.example.com -u "$RU" --password-stdin
            docker build -t "$IMAGE:$TAG" .
            docker push "$IMAGE:$TAG"
          '''
        }
      }
    }
    stage('Deploy') {
      when { beforeAgent true; expression { params.ENV != 'dev' } }
      steps {
        input message: "确认发布到 ${params.ENV}?", ok: 'Deploy'
        sh "./deploy.sh ${params.ENV} ${TAG}"
      }
    }
  }
  post {
    failure { sh './notify.sh failure' }
    success { sh './notify.sh success' }
    always  { cleanWs() }
  }
}
```

关键点逐条解释：

- **`options.timeout`**：没有超时，一个卡住的步骤会占着 executor 直到天荒地老。
- **`disableConcurrentBuilds`**：同一分支并发发布是事故来源。
- **`environment.TAG` 用 commit sha**：可追溯，不复用 `latest`。
- **`when { beforeAgent true }`**：先判断再分配 executor，否则跳过阶段也占资源。
- **`post.always { cleanWs() }`**：不清理会让构建节点磁盘慢慢填满（最常见的"Jenkins 越用越慢"原因）。
- **`input`**：生产发布的人工闸门。

### 凭据的正确用法

不要用 `parameters` 接密码，也不要用环境变量硬编码。

```groovy
withCredentials([string(credentialsId: 'sonar-token', variable: 'SONAR_TOKEN')]) {
  sh 'sonar-scanner -Dsonar.login=$SONAR_TOKEN'
}
```

规则：

1. 凭据只在 `withCredentials` 块内可见，块外无痕。
2. Jenkins 会把凭据值在日志里打码，但**在双引号里拼接进其他字符串时会漏**（用单引号 + shell 变量最稳）。
3. 用 `credentialsId` 而不是明文，凭据存 Jenkins 的 credentials store，不要写进 Git。

### 共享库该抽什么，不该抽什么

**该抽**：

- 多项目一致的构建模板（`buildAndPush(image, tag)`）。
- 通知、打点、清理这类横切逻辑。
- 环境部署的固定流程。

**不该抽**：

- 单个项目特有的分支逻辑。
- 把整条流水线塞进一个 `call()`，导致改一处要动所有项目。

```groovy
// vars/buildImage.groovy
def call(String image, String tag) {
  sh """
    docker build -t ${image}:${tag} .
    docker push ${image}:${tag}
  """
}
```

原则：**共享库提供"能力"，流水线描述"流程"**。反之会让流水线变成不可读的黑盒。

### 流水线越来越慢的四个原因

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 每个构建都从零拉依赖 | 无缓存 | 缓存 `~/.m2`、`node_modules`、`go mod cache`，用 volume 挂载 |
| 排队等 executor | 全局 executor 太少 / 阶段串行 | 拆 label、加节点、把可并行的阶段并行 |
| 单一阶段特别慢 | 在 Jenkins 里做重活（编译大镜像、跑全量集成测试） | 拆到独立 runner，或改用更轻的 CI |
| 越用越慢 | workspace 不清理、日志无限增长 | `cleanWs()` + `logRotator` |

缓存示例：

```groovy
stage('Build') {
  steps {
    sh '''
      export GOPATH=$WORKSPACE/.gopath
      export GOCACHE=$WORKSPACE/.gocache
      go build ./...
    '''
  }
}
```

把缓存放在 workspace 内，配 `cleanWs` 时排除缓存目录：

```groovy
cleanWs(deleteDirs: true, notFailBuild: true)
```

### 并发与资源

```groovy
// 限制某类任务同时只跑 2 个
stage('Integration') {
  options { lock resource: 'integration-env', quantity: 1 }
  steps { sh './run-integration.sh' }
}
```

`lock` 的价值：集成测试要独占测试环境，不加锁就会出现"两个构建互相踩数据"的诡异失败。

### 迁移到 GitHub Actions 还是留下？

| 条件 | 建议 |
| --- | --- |
| 已有大量 Jenkinsfile、插件依赖重 | 留下，先修慢与不稳 |
| 开源/公有云项目、构建简单 | 迁到 Actions |
| 需要自托管 runner 与内网访问 | 两者都能做，Jenkins 更成熟 |
| 团队不想维护 Jenkins 主节点 | 迁到托管 CI |

迁移成本主要不在脚本，而在**插件生态**（凭据、通知、制品库集成）。

### 可观测：让失败可定位

```groovy
post {
  unsuccessful {
    sh 'cp build.log "$WORKSPACE/build-failure.log" || true'
    archiveArtifacts artifacts: 'build-failure.log', allowEmptyArchive: true
  }
}
```

三件事必做：

1. **保留失败时的日志与产物**，不要 `cleanWs` 一刀切。
2. **构建结果推给 IM/邮件**，带构建号与链接。
3. **给流水线加阶段计时**，找出真正的瓶颈（而不是凭感觉优化）。
