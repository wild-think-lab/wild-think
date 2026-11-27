---
title: 依赖供应链安全：从"某个包被投毒"说起
description: 依赖风险的四种形态、锁文件与可复现构建、私有源与代理、SBOM 与漏洞扫描该怎么接进流水线、以及最小可行的落地顺序。
date: 2026-11-27
tags: [安全, 供应链, 依赖, SBOM, CI]
---

### 依赖风险有四种形态

**① 投毒**：攻击者拿到某个冷门包或抢注相似包名（typosquatting），植入恶意代码。

**② 账号失陷**：维护者账号被盗，合法包被推新版本。这是最难防的一类——签名、评分都是正常的。

**③ 传递依赖**：你直接依赖 3 个包，实际拉进来 800 个。真正出问题的通常是第 5 层的某个包。

**④ 已知漏洞**：包本身没恶意，但有 CVE（如 log4sh 类问题）。

### 第一道防线：锁文件 + 可复现构建

```bash
# 必须提交锁文件
package-lock.json / pnpm-lock.yaml / go.sum / poetry.lock / requirements.txt(带 hash)
```

判断标准很简单：**在 CI 里用 `npm ci` 而不是 `npm install`**。`ci` 只认锁文件，版本漂移立刻暴露出"锁文件没提交"。

Python 用 hash 锁定：

```
requests==2.31.0 --hash=sha256:58cd2187c01e70e6e26505bca751777aa9f2ee0b7f4300988b709f44e013003f
```

```bash
pip install --require-hashes -r requirements.txt
```

这样即使同一个版本号的内容被换掉，hash 校验也会失败。

### 第二道防线：私有源与代理

不要直连公网 registry：

```
开发者 / CI  →  内部制品库（Nexus/Artifactory/自建 proxy）  →  公网源
```

好处：

1. **审核入口唯一**：新包进内部库要过扫描，能拦住投毒包。
2. **可用性**：公网源挂了不影响构建。
3. **可追溯**：谁在哪天引入了哪个包，有记录。

```ini
# .npmrc
registry=https://npm.internal.example.com/repository/npm-group/
always-auth=true
```

Go 用 `GOPROXY`，Python 用 `index-url`，Rust 用 `source replacement`。

### 第三道防线：漏洞扫描接进流水线

```yaml
# GitHub Actions 示例
- name: Scan dependencies
  uses: aquasecurity/trivy-action@master
  with:
    scan-type: fs
    severity: CRITICAL,HIGH
    exit-code: "1"          # 有高危就失败
    ignore-unfixed: true    # 忽略无修复方案的
```

关键参数：`ignore-unfixed` 必须有，否则一堆"官方也没有补丁"的漏洞会让流水线永远红。

阈值策略建议：

| 严重级别 | 处理 |
| --- | --- |
| CRITICAL 且可修 | 阻断发布 |
| HIGH 且可修 | 阻断，允许例外申请 |
| MEDIUM 及以下 | 只记录，按周处理 |

不设阈值的扫描等于没扫：报告全绿没人看，全红也没人看。

### SBOM：把"我用了什么"变成可查

```bash
# 生成 CycloneDX 格式
syft packages dir:. -o cyclonedx-json > sbom.json

# 基于 SBOM 做漏洞匹配
grype sbom:sbom.json
```

SBOM 的价值在**事后追溯**：某个包爆出 0day 时，能在 5 分钟内回答"我哪些镜像用了它"。

```bash
# 典型查询：哪些镜像包含 log4j-core
for img in $(cat images.txt); do
  syft "$img" -o json | jq -r '.artifacts[].name' | grep -q log4j-core && echo "$img"
done
```

没有 SBOM 时，这个问题要靠人肉回忆，代价是几天。

### 镜像侧的三条硬规则

1. **基础镜像固定 digest**，不用可漂移的 tag：

```dockerfile
FROM alpine:3.19@sha256:xxxxx
```

`latest` 每天可能变，构建不可复现。

2. **多阶段构建减少攻击面**：最终镜像不留编译器、包管理器、源码。

```dockerfile
FROM golang:1.22 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app ./cmd/app

FROM gcr.io/distroless/static
COPY --from=build /out/app /app
ENTRYPOINT ["/app"]
```

3. **非 root 运行**：

```dockerfile
USER 65532:65532
```

k8s 侧再加 `securityContext.runAsNonRoot: true` 兜底。

### 落地顺序（别一次全上）

| 阶段 | 动作 | 收益 |
| --- | --- | --- |
| 第 1 周 | 提交锁文件 + CI 用 `npm ci`/`go mod verify` | 消除版本漂移 |
| 第 2 周 | 接 Trivy 扫 fs 与镜像，只报不拦 | 建立基线 |
| 第 3 周 | 设阈值（CRITICAL 阻断） | 开始拦 |
| 第 1 月 | 上内部制品库代理 | 审核入口唯一 |
| 第 2 月 | 每次发布产出 SBOM 并归档 | 事后可追溯 |

顺序很重要：**先可复现，再可观测，最后才阻断**。反过来做会让团队反感安全。

### 三个常见误区

1. **"我们依赖很少，不用管"**：传递依赖会把数量放大 10–100 倍。
2. **"有 WAF 就够了"**：WAF 防不了"你自己的代码里带了恶意包"。
3. **"扫描通过了就安全"**：扫描只覆盖已知漏洞，投毒与 0day 检测不到。锁文件 + 私有源 + 最小镜像才是真正的降低面。
