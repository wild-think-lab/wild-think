---
title: GitHub Actions 流水线速查
summary: 触发条件、缓存、矩阵、权限与密钥、复用与调试，附五个常见报错的解法。
group: 自动化
order: 3
tags: [ci, github-actions, devops]
---

## 一、最小工作流

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
```

## 二、触发条件

```yaml
on:
  push:
    branches: [main]
    paths: ['src/**', 'package.json']       # 只在相关文件变更时触发
  pull_request:
    types: [opened, synchronize]
  schedule:
    - cron: '0 2 * * *'                    # UTC 时间
  workflow_dispatch:                       # 手动触发
    inputs:
      env:
        description: '环境'
        required: true
        default: staging
```

**`cron` 用 UTC**：北京时间 10:00 = UTC 02:00。

## 三、缓存

```yaml
- uses: actions/cache@v4
  with:
    path: |
      ~/.npm
      ~/.cache/go-build
      ~/go/pkg/mod
    key: ${{ runner.os }}-${{ hashFiles('**/package-lock.json', 'go.sum') }}
    restore-keys: |
      ${{ runner.os }}-
```

**key 规则**：包含锁文件 hash → 锁变了才失效；`restore-keys` 提供前缀回退（部分命中）。

## 四、矩阵

```yaml
strategy:
  fail-fast: false          # 一个失败不取消其他
  matrix:
    os: [ubuntu-latest, windows-latest]
    node: [18, 20]
    exclude:
      - os: windows-latest
        node: 18
jobs:
  test:
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }} }
```

## 五、权限与密钥

```yaml
permissions:
  contents: read            # 默认收紧（最小权限）
  packages: write

jobs:
  publish:
    permissions:
      contents: read
      packages: write
    steps:
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
```

| 方式 | 用途 |
| --- | --- |
| `secrets.X` | 仓库/组织密钥 |
| `GITHUB_TOKEN` | 内置令牌（权限由 `permissions` 控制） |
| OIDC（`id-token: write`） | 免密钥云厂商认证（推荐） |

**`pull_request` 来自 fork 时拿不到 secrets**（安全设计），需要 `pull_request_target`（但要极度小心，会带来注入风险）。

## 六、条件执行与产物

```yaml
- name: Deploy
  if: github.ref == 'refs/heads/main' && github.event_name == 'push'
  run: ./deploy.sh

- uses: actions/upload-artifact@v4
  with:
    name: dist
    path: dist/
    retention-days: 7

- uses: actions/download-artifact@v4
  with: { name: dist, path: dist/ }
```

**跨 job 传文件必须用 artifact**（job 之间不共享文件系统）。

## 七、复用

```yaml
# 复用别的仓库的 workflow
uses: org/repo/.github/workflows/build.yml@main
with:
  node-version: 20

# 本地 composite action（.github/actions/setup/action.yml）
- uses: ./.github/actions/setup
```

## 八、调试

```yaml
- name: Debug
  run: |
    echo "ref=${{ github.ref }}"
    echo "event=${{ github.event_name }}"
    env | sort | grep -i 'CI\|GITHUB'
```

**开启调试日志**：在仓库 Settings → Secrets 里加 `ACTIONS_STEP_DEBUG=true`。

本地复现用 `act`：

```bash
act -j test -s GITHUB_TOKEN=dummy
```

## 九、五个常见报错

| 报错 | 原因 | 解法 |
| --- | --- | --- |
| `Permission denied` 推镜像 | `permissions` 没给 `packages: write` | 加权限 |
| `Resource not accessible by integration` | `GITHUB_TOKEN` 权限不足 | 同上，或改用 PAT |
| `No such file or directory` | 上一步的产物不在同一 job | 用 artifact 传递 |
| cache 一直 miss | key 里含每次都变的值（如时间戳） | key 用锁文件 hash |
| 定时任务不跑 | 仓库 60 天无活动会自动停用 schedule | 手动触发一次或保持提交 |

## 十、安全要点

```
□ permissions 默认只读
□ 第三方 action 固定到 commit sha（不是 @main）
□ 不在 PR 日志里打印 secrets
□ 用 OIDC 替代长期密钥
□ pull_request_target 慎用（会拿到 secrets）
□ 敏感 job 加 environment 保护规则（需人工批准）
```
