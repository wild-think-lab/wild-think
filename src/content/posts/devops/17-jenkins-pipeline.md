---
title: Jenkins 流水线：从"能跑"到"跑得快、跑得稳"
description: Declarative vs Scripted、共享库、并行与缓存、失败重试，以及五个让流水线越来越慢的原因。
date: 2026-11-27
tags: [Jenkins, CI/CD, DevOps]
---

### 两种流水线的取舍

```
Declarative（声明式）：pipeline { agent/stages/steps }
Scripted（脚本式）   ：node { stage('x') { ... } }
```

**推荐 Declarative**：

```
① 结构清晰（易 review）
② 内置 post/options/environment
③ 与 Blue Ocean 兼容好
```

**需要复杂逻辑时**，在 step 里用 `script { }` 写 Groovy。

### 一个"够用"的模板

```groovy
pipeline {
  agent { label 'docker' }
  options {
    timeout(time: 30, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '30'))
    disableConcurrentBuilds()
    timestamps()
  }
  environment {
    REGISTRY = 'registry.example.com'
    IMAGE    = "${REGISTRY}/app"
  }
  stages {
    stage('Checkout') {
      steps { checkout scm }
    }
    stage('Lint & Test') {
      parallel {
        stage('lint') { steps { sh 'make lint' } }
        stage('unit') { steps { sh 'make test' } }
      }
    }
    stage('Build') {
      steps {
        sh 'docker build -t $IMAGE:$GIT_COMMIT .'
      }
    }
    stage('Push') {
      when { branch 'main' }
      steps {
        sh 'docker push $IMAGE:$GIT_COMMIT'
      }
    }
    stage('Deploy') {
      when { branch 'main' }
      steps {
        sh './deploy.sh $GIT_COMMIT'
      }
    }
  }
  post {
    always  { junit '**/reports/*.xml'; archiveArtifacts 'dist/**' }
    failure { slackSend channel: '#ci', message: "FAILED: ${env.JOB_NAME} ${env.BUILD_NUMBER}" }
  }
}
```

**`options` 里的四项都很重要**：

```
timeout              ：防卡死（否则占着 executor）
buildDiscarder       ：防磁盘被历史构建撑爆
disableConcurrentBuilds：防同一分支并发冲突
timestamps           ：日志带时间（排查必需）
```

### 五个让流水线越来越慢的原因

**① 每次从头装依赖**

```
npm ci 每次 3 分钟、pip install 每次 2 分钟
```

**处理**：

```groovy
stage('Cache') {
  steps {
    cache(maxCacheSize: 500, caches: [
      arbitraryFileCache(path: '.npm', cacheValidity: '7d'),
      arbitraryFileCache(path: '.cache/pip', cacheValidity: '7d')
    ]) {
      sh 'npm ci'
    }
  }
}
```

**或用"预构建的 CI 镜像"**（把依赖打进镜像，最彻底）。

**② 串行跑所有阶段**

```groovy
parallel {
  stage('unit') { ... }
  stage('integration') { ... }
  stage('security-scan') { ... }
}
```

**"互不依赖的测试应并行"**，但注意 executor 数量。

**③ 构建在 master 上跑**

```
master 还要调度、存 UI
→ 构建全部拖慢整个人机交互
```

**处理**：master 只调度，构建跑在 agent（K8s/Docker/静态节点）。

**④ 日志无节制**

```
一次构建打 500MB 日志 → 磁盘与界面都卡
```

**处理**：`sh 'set +x; ...'`（关命令回显）+ 只打关键输出 + 日志轮转。

**⑤ 没清工作区**

```
workspace 越积越大 → checkout 越来越慢
```

**处理**：

```groovy
options { skipDefaultCheckout(true) }
steps {
  deleteDir()
  checkout scm
}
```

**"每次先 deleteDir"能避免大量诡异问题**（残留产物导致的假通过）。

### 共享库（Shared Library）

**为什么需要**：

```
10 个仓库各自写一遍流水线 → 改一次要改 10 处
```

**结构**：

```
(root)
├── vars/
│   └── standardPipeline.groovy
└── src/
    └── org/example/Utils.groovy
```

```groovy
// vars/standardPipeline.groovy
def call(Map config = [:]) {
  pipeline {
    agent { label config.agent ?: 'docker' }
    stages {
      stage('Build') { steps { sh config.buildCmd ?: 'make build' } }
    }
  }
}
```

**Jenkinsfile 变成一行**：

```groovy
@Library('shared-lib') _
standardPipeline(buildCmd: 'make build', agent: 'docker')
```

**"用共享库统一流水线"是规模化的必经之路**。

### 多分支流水线

```
Multibranch Pipeline：自动发现分支/PR 并建 job
```

**要点**：

```
① 用 Jenkinsfile（不要用 UI 配置）
② PR 构建只跑"检查"，不部署
③ 用 `when { branch 'main' }` 控制部署
④ 分支保护（必须 CI 通过才能合）
```

### 与 K8s 集成

```groovy
pipeline {
  agent {
    kubernetes {
      yaml '''
        spec:
          containers:
          - name: build
            image: golang:1.24
            command: ['sleep']
            args: ['99d']
      '''
    }
  }
  stages {
    stage('Build') {
      steps { container('build') { sh 'go build ./...' } }
    }
  }
}
```

**价值**：

```
① 环境与镜像一致（不再"本地能跑 CI 不能"）
② 每个构建独立（无残留污染）
③ 弹性（按需起 Pod）
```

**代价**：Pod 启动有 20–60s 开销（小项目不如静态节点）。

### 失败与重试

```groovy
retry(2) {
  sh './flaky-test.sh'
}
```

**但"重试成功"要能看见**：

```
① 记录"重试次数"到构建描述
② 频繁重试的用例要单独治理（不稳定测试是技术债）
```

**"靠重试掩盖不稳定测试"会让团队失去对 CI 的信任**。

### 凭证管理

```groovy
withCredentials([string(credentialsId: 'slack-token', variable: 'SLACK_TOKEN')]) {
  sh './notify.sh'
}
```

**规则**：

```
① 凭证存 Jenkins（不要写进代码/日志）
② `set +x` 防止命令回显泄露
③ 用最小权限的专用账号（不是管理员 token）
```

**"日志里有 token"是常见的泄露途径**。

### 检查清单

```
□ Declarative + 复杂逻辑用 script{}
□ timeout / buildDiscarder / disableConcurrentBuilds / timestamps
□ 互不依赖的阶段 parallel
□ 依赖缓存或预构建镜像
□ master 不跑构建
□ 工作区先 deleteDir
□ 日志关回显 + 关键输出
□ 共享库统一流水线
□ 多分支流水线 + PR 只检查
□ K8s agent（按需选择）
□ 凭证走 withCredentials + set +x
□ 不稳定测试单独治理（不靠重试掩盖）
```
