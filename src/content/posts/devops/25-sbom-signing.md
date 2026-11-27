---
title: SBOM 与镜像签名：供应链安全的两个抓手
description: SBOM 生成与消费、签名与验证链路、五个"扫了但没防住"的原因。
date: 2026-08-01
tags: [安全, 供应链, 镜像]
---

### 两个抓手

```
① SBOM（软件物料清单）：我用了什么
② 签名（Signing）：这东西是不是我构建的、有没有被改
```

**"只有扫描没有清单"** → 出事时不知道"影响哪些镜像"。

### 生成 SBOM

```bash
# Syft（镜像/目录/文件系统）
syft registry.example.com/app:1.4.2 -o spdx-json > sbom.json

# Trivy 也能生成
trivy image --format spdx-json -o sbom.json registry.example.com/app:1.4.2

# 构建时生成（推荐，与制品绑定）
docker buildx build --sbom=true --push -t app:1.4.2 .
```

**格式选择**：

```
SPDX / CycloneDX —— 两者都能被主流工具消费
```

**"SBOM 与镜像一起存"** 才能"查漏洞时直接查清单"。

### 消费 SBOM（漏洞爆发时怎么用）

```
① 新 CVE 出现 → 在 SBOM 库里搜"哪些镜像包含该组件"
② 得到"受影响镜像清单"
③ 按"是否对外/是否在跑"排优先级
④ 升级/重建/替换
```

```bash
# 用 grype 扫 SBOM 而不是扫镜像（更快、可离线）
grype sbom:sbom.json
```

**"每次 CVE 都重新扫全部镜像"** 又慢又容易漏（有 SBOM 只需查清单）。

### 镜像签名

```bash
# 生成密钥
cosign generate-key-pair

# 签名（by digest 而不是 tag）
cosign sign --key cosign.key registry.example.com/app@sha256:abc...

# 验证
cosign verify --key cosign.pub registry.example.com/app@sha256:abc...
```

**"按 digest 签名"** 是关键：

```
tag 会变，digest 不会变（tag 被覆盖后签名就失效）
```

### 验证链路（准入层）

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signature
spec:
  validationFailureAction: Enforce
  rules:
  - name: check-signature
    match:
      any:
      - resources: {kinds: [Pod]}
    verifyImages:
    - imageReferences: ["registry.example.com/*"]
      attestors:
      - entries:
        - keys:
            publicKeys: |-
              -----BEGIN PUBLIC KEY-----
              ...
              -----END PUBLIC KEY-----
```

**"签名了但没人验证"** → 等于没签。

### 五个"扫了但没防住"

**① 只在 CI 扫，运行时不管**

```
部署时拉的是"没扫过的新 tag" → 绕过
→ 准入层要校验 digest/签名
```

**② 扫描不阻断**

```
高危也"仅告警" → 没人修
```

**③ 基础镜像没管**

```
应用层很干净，但基础镜像里有 200 个漏洞
→ 定期重建基础镜像
```

**④ 只扫 OS 包，不扫语言依赖**

```
jar/npm 里的漏洞常被漏（要开对应扫描器）
```

**⑤ SBOM 生成了但没存**

```
"事后补"来不及（镜像可能已被删）
```

### 一个"最小可行"的链路

```
① 构建时：生成 SBOM + 签名（by digest）
② 入库时：SBOM 与镜像一起存（同仓库/同 bucket）
③ 准入时：验签 + 校验仓库白名单
④ 巡检时：CVE 出现 → 查 SBOM 库定位影响面
⑤ 修复时：重建 + 重新签名 + 替换
```

### 检查清单

```
□ 构建产出 SBOM（SPDX/CycloneDX）
□ SBOM 与镜像同存
□ 按 digest 签名
□ 准入层验签（Enforce 而非 Audit）
□ 只允许白名单仓库
□ 扫描含 OS + 语言依赖
□ 高危可阻断
□ 基础镜像定期重建
□ CVE 爆发有"查 SBOM"的流程
□ 有"受影响镜像清单"能力
```
