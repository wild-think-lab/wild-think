---
title: Jenkins 速查
summary: 流水线语法、常用 step、凭据与 agent 配置、排错要点，以及"Jenkins 慢"的四个原因。
group: DevOps
order: 1
tags: [jenkins, ci, 流水线]
---

## 一、架构与目录

```
Jenkins Controller（调度、UI、配置）
  ├── Agent（执行机，label 匹配）
  └── 凭据（Credentials Store）
```

```bash
# 主目录
/var/lib/jenkins                # 常见路径
JENKINS_HOME=/var/lib/jenkins

# 关键文件
config.xml                      # 全局配置
jobs/<name>/config.xml          # 任务配置
credentials.xml                 # 凭据（加密）
plugins/                        # 插件
```

## 二、Declarative 流水线骨架

```groovy
pipeline {
  agent { label 'docker' }

  options {
    timeout(time: 20, unit: 'MINUTES')
    timestamps()
    buildDiscarder(logRotator(numToKeepStr: '30'))
    disableConcurrentBuilds()
  }

  environment {
    IMAGE = "registry.example.com/app"
    TAG = "${env.GIT_COMMIT.take(7)}"
  }

  stages {
    stage('Checkout') {
      steps { checkout scm }
    }

    stage('Lint') {
      steps { sh 'make lint' }
    }

    stage('Test') {
      steps {
        sh 'make test'
      }
      post {
        always {
          junit 'reports/**/*.xml'
          archiveArtifacts artifacts: 'reports/**', allowEmptyArchive: true
        }
      }
    }

    stage('Build Image') {
      steps {
        sh """
          docker build -t $IMAGE:$TAG .
          docker push $IMAGE:$TAG
        """
      }
    }

    stage('Deploy') {
      when { branch 'main' }
      input {
        message "部署到生产?"
        ok "确认"
      }
      steps {
        withCredentials([sshUserPrivateKey(credentialsId: 'deploy-key',
                                           keyFileVariable: 'KEY')]) {
          sh '''
            ssh -i "$KEY" -o StrictHostKeyChecking=no deploy@prod "cd /srv && ./deploy.sh"
          '''
        }
      }
    }
  }

  post {
    success { echo "构建成功 ${env.BUILD_URL}" }
    failure {
      echo "构建失败 ${env.BUILD_URL}"
      // slackSend / mail 等
    }
    always { cleanWs() }
  }
}
```

## 三、常用 step

```groovy
// shell
sh 'make build'
sh script: 'echo $X', returnStdout: true

// 归档与报告
archiveArtifacts artifacts: 'dist/**', fingerprint: true
junit '**/TEST-*.xml'
publishHTML target: [reportDir: 'coverage', reportFiles: 'index.html', reportName: 'Coverage']

// 凭据
withCredentials([usernamePassword(credentialsId: 'docker-hub',
                                  usernameVariable: 'U', passwordVariable: 'P')]) {
  sh 'echo $P | docker login -u $U --password-stdin'
}

// 参数
parameters {
  string(name: 'BRANCH', defaultValue: 'main')
  choice(name: 'ENV', choices: ['dev', 'staging', 'prod'])
  booleanParam(name: 'SKIP_TEST', defaultValue: false)
}

// 并行
stage('Tests') {
  parallel {
    stage('unit') { steps { sh 'make test-unit' } }
    stage('integration') { steps { sh 'make test-integration' } }
  }
}

// 重试
retry(3) { sh './flaky.sh' }

// 循环
for (envName in ['dev', 'staging']) {
  sh "./deploy.sh ${envName}"
}
```

## 四、凭据类型与用法

| 类型 | 用途 |
| --- | --- |
| Secret text | token、密码字符串 |
| Username with password | 基础认证 |
| SSH Username with private key | SSH 部署 |
| Secret file | kubeconfig、证书 |
| Certificate | PKCS#12 |

```groovy
withCredentials([file(credentialsId: 'kubeconfig', variable: 'KCFG')]) {
  sh 'kubectl --kubeconfig "$KCFG" get pods'
}
```

**安全要点**：

```
① 不在 Groovy 字符串里拼接密码（会显示在日志）
② 用 withCredentials 注入环境变量（Jenkins 会打码）
③ 定期轮换（凭据泄露很难发现）
```

## 五、agent 配置

```groovy
// 全局
agent any
agent { label 'linux && docker' }

// 单 stage 指定
stage('Build') {
  agent { label 'builder' }
  steps { ... }
}

// 容器内
agent {
  docker {
    image 'golang:1.21'
    args '-v /var/run/docker.sock:/var/run/docker.sock'
    reuseNode true
  }
}

// Kubernetes 动态 agent
agent {
  kubernetes {
    yaml '''
      spec:
        containers:
        - name: build
          image: golang:1.21
          command: [sleep]
          tty: true
    '''
  }
}
```

**K8s 动态 agent 的好处**：每个构建起一个 Pod，用完就删（不污染长期 agent）。

## 六、Webhook 触发

```
GitHub/GitLab → Jenkins：
① Jenkins 装 Git plugin + GitHub plugin
② 任务里勾 "GitHub hook trigger for GITScm polling"
③ GitHub 仓库设 webhook：http://jenkins/github-webhook/
```

**内网 Jenkins 收不到公网 webhook** 的解法：

```
① 用公网可达的反向代理（带鉴权）
② 或轮询（pollSCM，延迟 1 分钟，但配置简单）
```

## 七、"Jenkins 慢"的四个原因

**① agent 不足**

```
排队时间 >> 构建时间
看：任务页面的 "Pending" 状态与队列
```

**② 每次都全新拉代码 + 装依赖**

```
没有缓存 workspace 或依赖目录
→ 在 Docker agent 里每次 npm ci 要 2 分钟
```

对策：挂载缓存卷，或用 `reuseNode`。

**③ Controller 上跑构建**

```
Controller 只应调度，构建在 agent
"built-in node" 上跑构建会让 UI 卡
```

**④ 历史构建太多**

```
默认保留所有构建 → 磁盘满 + UI 慢
```

```groovy
options { buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '10')) }
```

## 八、常见报错

| 报错 | 原因 |
| --- | --- |
| `No such DSL method` | 插件缺失或拼错 |
| `script returned exit code 1` | 命令失败（看前面输出） |
| `java.io.NotSerializableException` | Groovy 里用了不可序列化对象（用 `@NonCPS`） |
| `Could not find credentials` | 凭据 ID 拼错或作用域不对 |
| `Permission denied (publickey)` | SSH 私钥格式/权限 |
| `Timeout has been exceeded` | 检查 `options.timeout` |
| `Docker: command not found` | agent 没装 docker 或没挂 socket |

**`NotSerializableException` 的处理**：

```groovy
@NonCPS
def parseJson(String s) {
  new groovy.json.JsonSlurper().parseText(s)
}
```

## 九、Shared Library

```groovy
// vars/buildImage.groovy（在共享库仓库里）
def call(Map cfg) {
  sh """
    docker build -t ${cfg.image}:${cfg.tag} .
    docker push ${cfg.image}:${cfg.tag}
  """
}
```

```groovy
// Jenkinsfile 里
@Library('my-shared-lib') _
buildImage(image: 'app', tag: env.GIT_COMMIT.take(7))
```

**用途**：把"标准流程"固化成库，各项目复用（也便于统一升级）。

## 十、备份与恢复

```bash
# 最简单：整个 JENKINS_HOME（停服务后拷）
systemctl stop jenkins
tar czf jenkins-backup.tar.gz /var/lib/jenkins
systemctl start jenkins

# 只备份配置（不含构建历史）
tar czf cfg.tar.gz /var/lib/jenkins/{config.xml,jobs,credentials.xml,users}
```

**注意**：`credentials.xml` 里的密钥依赖 `$JENKINS_HOME/secret.key`（要一起备份，否则凭据不可用）。

## 十一、检查清单

```
□ Controller 不跑构建（只用 agent）
□ 有 timeout（防卡死占用 agent）
□ 有 buildDiscarder（限制历史）
□ 凭据用 withCredentials（不拼字符串）
□ agent 有 label 区分（builder / docker）
□ 失败有通知
□ 关键分支有 input 审批
□ 依赖有缓存（不每次重装）
□ 配置有备份（含 secret.key）
□ Shared Library 固化标准流程
□ 定期清理 workspace
```
