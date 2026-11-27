---
title: API 网关选型：Kong、APISIX、Higress 怎么选
description: 网关该承担什么、三家的架构差异、插件生态与性能量级、迁移成本，以及"要不要自建"的判断。
date: 2026-11-27
tags: [网关, Kong, APISIX, Higress, 架构]
---

### 网关到底管什么

```
认证鉴权（JWT/OAuth/Key）
限流限速（按用户/接口/IP）
路由与重写（路径、灰度、AB 测试）
熔断重试
日志与链路（trace id）
协议转换（HTTP ↔ gRPC）
```

如果只做"转发 + HTTPS 卸载"，Nginx 就够了。**引入网关是因为需要上面这些的"可配置化"**。

### 三家对比

| | Kong | APISIX | Higress |
| --- | --- | --- | --- |
| 语言 | Lua（OpenResty） | Lua（OpenResty） | Go + Rust（Envoy 内核） |
| 性能 | 高 | 高 | 很高（Envoy） |
| 动态配置 | 有（DB/声明式） | 有（etcd，秒级生效） | 有（K8s CRD 为主） |
| 插件 | 官方 + 商业 | 80+ 开源 | 兼容部分 Nginx/Envoy 插件 |
| 配置存储 | Postgres/Cassandra | etcd | K8s CRD |
| 国内生态 | 一般 | 很好（Apache 项目） | 阿里系，文档中文好 |
| 上手 | 中 | 中 | 偏低（K8s 原生） |

**判断口诀**：

- 已经在 K8s 上跑、想要"少一个中间件"→ **Higress**。
- 需要丰富插件与成熟商业支持 → **Kong**。
- 想要纯自建、配置灵活、国内社区活跃 → **APISIX**。

### APISIX 快速上手

```yaml
# config.yaml
apisix:
  node_listen: 9080
deployment:
  role: traditional
  role_traditional:
    config_provider: etcd
  etcd:
    host: ["http://127.0.0.1:2379"]
```

```bash
# 添加路由（Admin API）
curl -X PUT http://127.0.0.1:9180/apisix/admin/routes/1 \
  -H 'X-API-KEY: edd1c9f034335f136f87ad84b625c8f1' \
  -d '{
    "uri": "/api/*",
    "upstream": {
      "type": "roundrobin",
      "nodes": { "10.0.0.10:8080": 1, "10.0.0.11:8080": 1 }
    }
  }'
```

加限流插件：

```json
{
  "plugins": {
    "limit-req": { "rate": 100, "burst": 50, "rejected_code": 429, "key_type": "var", "key": "remote_addr" }
  }
}
```

### Kong 快速上手

```yaml
# kong.yml（声明式，DB-less 模式）
_format_version: "3.0"
services:
  - name: api
    url: http://api:8080
    routes:
      - name: api-route
        paths: ["/api"]
        strip_path: true
    plugins:
      - name: rate-limiting
        config: { minute: 100, policy: local }
```

```bash
deck sync --konnect-control-plane-name default   # 或 kong config db_import kong.yml
```

**DB-less 模式**把配置放 Git，适合"配置即代码"，但动态变更需要 reload。

### Higress 快速上手

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api
  annotations:
    higress.io/backend-protocol: HTTP
    higress.io/rate-limit-qps: "100"
spec:
  ingressClassName: higress
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service: { name: api, port: { number: 8080 } }
```

用 Ingress 注解就能配置插件，与 K8s 生态贴合度最高。

### 性能量级

单机 4C8G、简单转发、小包：

| | QPS（约） | P99 延迟 |
| --- | --- | --- |
| Nginx | 15k+ | < 2ms |
| Kong | 10k | 2–4ms |
| APISIX | 12k | 2–3ms |
| Higress | 15k+ | 1–2ms |

**量级都在万级**。业务 QPS 在几千以内时，选型看生态与运维成本，不看性能。

### 迁移成本

从 Nginx 迁到网关：

```
① 把 nginx.conf 里的 location 翻译成路由（可用工具辅助）
② 把 rewrite 逻辑翻译成网关的 rewrite 插件（复杂正则需要重写）
③ 把 limit_req 换成网关限流插件（参数语义不同）
④ 灰度：先切一个域名/一个路径，双跑对比
⑤ 回滚：DNS 或上层 LB 切回 Nginx
```

**最容易出问题的是 rewrite 与 header 处理**，建议先用流量回放（把线上请求打到新网关，对比响应）。

### 要不要自建

| 情况 | 建议 |
| --- | --- |
| 只有 1–3 个服务 | Nginx 足够，不上网关 |
| 服务 5+、需要统一鉴权限流 | 上网关 |
| 已有成熟云厂商 API 网关 | 先用云产品，除非有成本/合规问题 |
| 需要 L7 灰度 + 多协议 | 网关 + Service Mesh 一起考虑 |

**网关是"新增一个必须运维的组件"**：要考虑它的高可用（至少 2 副本）、配置备份、升级计划。

### 高可用部署要点

```
① 网关自身多副本 + 前面有 LB（或 K8s Service）
② 配置存储（etcd/DB）也要高可用
③ 健康检查到上游，避免打到故障节点
④ 网关的日志要能定位到"哪个上游、哪次重试"
```

### 检查清单

```
□ 明确需要哪些能力（鉴权/限流/灰度/协议转换）
□ 选型考虑现有生态（K8s → Higress；传统 → APISIX/Kong）
□ 网关至少 2 副本 + 配置存储高可用
□ 配置在 Git（可回滚、可审计）
□ 有灰度方案与回滚路径
□ 监控：QPS、P99、5xx 率、上游健康
```
