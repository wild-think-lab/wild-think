---
title: LDAP 与 SSO：一套账号打通所有系统
description: LDAP 的模型、SSO 三种协议（OAuth2/OIDC/SAML）的取舍、对接内网系统的步骤，以及"用户能登录但没权限"的排查。
date: 2024-11-26
tags: [身份认证, LDAP, SSO, 运维]
---

### LDAP 是什么（一句话）

```
一个"树形"的账号目录数据库，用 DN 定位一个条目，用属性描述它。
```

示例 DN：

```
uid=alice,ou=people,dc=example,dc=com
```

层级：

```
dc=example,dc=com            （根）
├── ou=people                （人员）
│   ├── uid=alice
│   └── uid=bob
└── ou=groups                （组）
    └── cn=devops
```

### LDAP 常见属性

| 属性 | 含义 |
| --- | --- |
| `uid` | 用户唯一标识 |
| `cn` | 通用名（显示名） |
| `mail` | 邮箱 |
| `memberOf` | 所属组（多数实现支持） |
| `objectClass` | 类型（person / inetOrgPerson） |

查询：

```bash
ldapsearch -x -H ldap://ldap.example.com -b "dc=example,dc=com" \
  -D "cn=admin,dc=example,dc=com" -w 'pass' "(uid=alice)"
```

### 三种 SSO 协议

| 协议 | 典型用途 | 特点 |
| --- | --- | --- |
| OAuth2 + OIDC | 现代 Web/移动应用 | 基于 JSON/JWT，最容易集成 |
| SAML 2.0 | 企业老系统（如部分云服务） | XML 签名，配置繁琐但通用 |
| CAS | 校园/老系统 | 简单，生态较小 |

**新系统一律用 OIDC**：它是 OAuth2 之上的身份层，标准且工具链丰富。

### 选型结构

```
IdP（身份提供者）：Keycloak / Authentik / 云厂商（阿里云 IDaaS、飞书）
  ↓ OIDC
应用们（Grafana、GitLab、Jenkins、Wiki、自研系统）
```

**Keycloak 是最常用的自建方案**：开源、支持 LDAP 联邦（把 LDAP 当用户源）、支持 OIDC/SAML。

### Keycloak + LDAP 对接步骤

```
① 部署 Keycloak（容器最简单）
② 建 Realm（如 company）
③ User Federation → 添加 LDAP
   - 连接 URL、Bind DN、Bind 密码
   - Users DN: ou=people,dc=example,dc=com
   - Username 属性: uid
④ Test connection / Test authentication
⑤ 同步用户（可选定时同步）
⑥ 建 Client（每个应用一个）
   - Client ID、回调地址、Client 类型（confidential/public）
⑦ 应用侧配置 OIDC 客户端
```

容器启动：

```bash
docker run -d --name keycloak -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=StrongPass \
  quay.io/keycloak/keycloak:26.0 start-dev
```

生产要接数据库（Postgres）并启用 HTTPS。

### 应用侧（以 Grafana 为例）

```ini
[auth.generic_oauth]
enabled = true
name = Company SSO
client_id = grafana
client_secret = xxx
scopes = openid profile email groups
auth_url = https://sso.example.com/realms/company/protocol/openid-connect/auth
token_url = https://sso.example.com/realms/company/protocol/openid-connect/token
api_url = https://sso.example.com/realms/company/protocol/openid-connect/userinfo
role_attribute_path = contains(groups[*], 'devops') && 'Admin' || 'Viewer'
```

**`role_attribute_path` 是关键**：把 SSO 里的组映射到应用的角色。

### "能登录但没权限"的排查

这是 SSO 集成最常见的现象。

| 现象 | 原因 |
| --- | --- |
| 能登录，看到空白/无数据 | 角色映射没生效（组名不匹配） |
| 能登录，提示"无访问权限" | 应用侧有额外白名单（如 `allowed_domains`、`allowed_groups`） |
| 登录后立刻被踢出 | 回调地址（redirect_uri）不匹配 |
| 一部分人能进一部分不能 | 组属性没同步（LDAP → IdP 同步延迟） |
| 令牌里没有 groups | Client 的 scope 没勾 `groups`，或 mappers 没配 |

**检查顺序**：

```
① 看令牌内容（在 IdP 的 token 预览里看有没有 groups/roles）
② 看应用的映射配置（属性名是否一致）
③ 看应用日志（通常是"role not found"或"user not in allowlist"）
```

解码 JWT：

```bash
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq
```

（base64url 需要补 padding，或用 `jwt-cli`）

### 组与权限的设计

```
① LDAP 组 → IdP 角色 → 应用角色，三层映射
② 应用内不要再维护一份用户列表（会漂移）
③ 只给"组"，不给"人"（人员变动只改组）
```

示例映射：

| LDAP 组 | Keycloak 角色 | Grafana 角色 |
| --- | --- | --- |
| cn=devops | devops | Admin |
| cn=dev | dev | Editor |
| cn=others | viewer | Viewer |

### 单点退出的现实

```
OIDC 的"登出"通常只清本应用会话，不清 IdP 会话
→ 用户点了登出，再访问别的应用仍是登录状态
```

对策：

```
① 使用 IdP 的 end_session_endpoint（OIDC RP-Initiated Logout）
② 接受"单点登录但不单点登出"（很多系统就是这样）
③ 敏感系统设较短会话有效期（如 8 小时）
```

### 安全要点

```
① 强制 HTTPS（OIDC 必须）
② Client Secret 放密钥管理，不入 Git
③ 回调地址白名单严格匹配（不要用通配）
④ 令牌有效期短 + 有刷新令牌
⑤ 管理后台（Keycloak admin）不暴露公网
⑥ 开启 MFA（TOTP/WebAuthn）
```

### 检查清单

```
□ 新系统统一用 OIDC（不用各搞一套账号）
□ 用户源在 LDAP/AD，IdP 做联邦
□ 权限按"组"分配，不按"人"
□ 令牌里包含 groups（配了 mapper）
□ 应用侧角色映射已验证
□ 回调地址严格白名单
□ Secret 不进 Git
□ IdP 管理后台不暴露公网
□ 有 MFA
```
