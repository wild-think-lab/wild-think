---
title: SonarQube 落地：从"扫了没人看"到"卡住合并"
description: 质量门禁怎么设、新代码与全量口径、五个"扫了没用"的原因、以及 Java/前端项目的接入方式。
date: 2026-11-26
tags: [工程, 代码质量, CI]
---

### 它回答三个问题

```
① 有没有明显 bug（空指针/资源泄漏）
② 有没有安全问题（硬编码密码/SQL 拼接）
③ 有没有"技术债"（重复代码/复杂度）
```

**"只当报告看"** → 三个月后没人打开。

### 质量门禁（Quality Gate）的关键

```
默认门槛按"新代码"算，而不是全量
```

**为什么**：

```
全量门槛 = 老项目永远红 → 没人管
新代码门槛 = "新写的必须干净" → 债务不再增长
```

推荐口径：

```
新代码覆盖率 ≥ 80%
新代码重复率 ≤ 3%
新代码 0 个 blocker/critical
新代码技术债 ≤ 5%
```

### 接入 CI（Scanner）

```bash
# Java (Maven)
mvn clean verify sonar:sonar \
  -Dsonar.projectKey=app \
  -Dsonar.host.url=https://sonar.example.com \
  -Dsonar.token=$SONAR_TOKEN \
  -Dsonar.coverage.jacoco.xmlReportPaths=target/site/jacoco/jacoco.xml
```

```yaml
# GitHub Actions
- run: npm ci && npm run test:coverage
- uses: SonarSource/sonarqube-scan-action@v2
  env:
    SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
    SONAR_HOST_URL: https://sonar.example.com
```

**覆盖率必须由测试工具产出并喂给 Scanner**（否则覆盖率永远是 0）。

### 五种语言的最少接入

```
Java：jacoco + mvn sonar:sonar
JS/TS：jest --coverage → sonar.javascript.lcov.reportPaths
Python：pytest --cov → coverage.xml
Go：go test -coverprofile → sonar.go.coverage.reportPaths
Shell：shellcheck 报告导入
```

### 分支与 PR 分析

```
① 主分支全量分析（每天/每次合并）
② PR 只分析"新代码"（快）
③ 门禁卡 PR 合并（而不是卡主分支构建）
```

**"只在发布前扫"** → 问题都堆到发布时才发现。

### 五个"扫了没用"

**① 没有门禁**

```
报告很红但照样合并
```

**② 全量口径**

```
老代码 500 个问题 → 大家视而不见
```

**③ 覆盖率造假**

```
测试只跑"能跑"的部分 → 覆盖率好看但无效
```

**④ 规则太吵**

```
默认规则全开 → 几千个"建议"（没人能处理）
```

**⑤ 没有 owner**

```
问题分配给"所有人" = 没人负责
```

### 规则集的收敛

```
① 先开"bug/漏洞"（blocker/critical）
② 再开"坏味道"里最常见 10 条
③ 项目自定义（排除生成代码/第三方）
④ 每季度评估"误报率"
```

**"一次开 200 条规则"** 会让团队直接放弃。

### 与"人工评审"的关系

```
SonarQube 管"机器能查的"
人工评审管"设计与语义"
```

**"有了扫描就不评审"** 是误解（它查不出"业务逻辑错"）。

### 检查清单

```
□ 门禁按"新代码"口径
□ PR 阶段就分析
□ 门禁卡合并
□ 覆盖率由测试产出并上传
□ 规则集收敛（先 bug/漏洞）
□ 排除生成代码
□ 有问题 owner 与修复 SLA
□ 每季度看误报率
□ 有"技术债趋势"看板
□ 人工评审仍保留
```
