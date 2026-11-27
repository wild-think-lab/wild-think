---
title: 认证与会话：Session、JWT、OAuth2 到底该选哪个
description: 三种主流方案的原理与代价、JWT 的五个常见误用、单点登录怎么串起来、Token 泄露与撤销怎么做，以及前后端分工的边界。
date: 2022-04-15
tags: [认证, JWT, OAuth2, 安全, 后端]
---

### 先分清两件事

- **认证（Authentication）**：你是谁。
- **授权（Authorization）**：你能做什么。

大部分"登录系统做不好"的问题，都是把这两件事混在一个 token 里，然后发现没法撤销、没法细粒度。

### 方案一：服务端 Session

```
登录 → 服务端建 session 记录 → 下发 cookie: SESSIONID=xxx
后续请求 → 服务端按 SESSIONID 查存储 → 拿到 user
```

优点：**能立即撤销**（删掉记录即可）、权限可随时改、不暴露用户信息。
缺点：需要共享存储（Redis），跨域要处理 cookie 策略，横向扩展依赖中心化存储。

```python
# 关键点：session 里只放 user_id，权限每次查
session = {"uid": 1001}
redis.setex(f"sess:{sid}", 1800, json.dumps(session))
```

### 方案二：JWT

JWT = `header.payload.signature`，服务端**不存状态**，靠签名验真。

优点：无状态、跨服务易传递、适合移动端与第三方。
缺点：**签发后无法撤销**（除非引入黑名单，那就又有状态了）、体积大、payload 明文可读。

五个常见误用：

1. **把敏感信息放进 payload**。JWT 只是 Base64，不是加密。手机号、角色列表都能被解出来。
2. **有效期设成 7 天**。token 泄露后有一周的攻击窗口。正确做法：access token 15 分钟 + refresh token 7 天。
3. **用 `alg: none` 或没校验算法**。这是经典漏洞，必须显式指定允许的算法。
4. **密钥硬编码且全环境共用**。用非对称（RS256/ES256），公钥验签、私钥签发，密钥轮换才可行。
5. **把权限写死在 token 里**。用户被降权后 token 还有旧权限，直到过期。

```python
# 签发（PyJWT）
payload = {
    "sub": "1001",
    "iat": now,
    "exp": now + 900,          # 15 分钟
    "scope": "order:read",     # 粗粒度，细粒度仍在服务端查
}
token = jwt.encode(payload, private_key, algorithm="ES256")
```

### 方案三：OAuth2 / OIDC

OAuth2 是**授权委托**协议，OIDC 在其上加了一层身份（`id_token`）。典型场景是"用企业微信/Google 登录"或"第三方应用访问你的资源"。

四个角色：

- Resource Owner（用户）
- Client（你的应用）
- Authorization Server（发 token 的）
- Resource Server（被访问的 API）

主流流程用 **Authorization Code + PKCE**：

```
① 前端跳转 /authorize?response_type=code&client_id=...&code_challenge=...
② 用户同意 → 回调 ?code=xxx
③ 后端用 code + code_verifier 换 access_token
④ 用 access_token 调 API
```

**不要用 Implicit 流程**（token 直接出现在 URL fragment 里），已经是被淘汰的写法。**也不要把 client_secret 放在前端**。

### 一张对比表

| | Session | JWT | OAuth2/OIDC |
| --- | --- | --- | --- |
| 状态 | 服务端有状态 | 无状态 | 授权服务器有状态 |
| 撤销 | 容易 | 难（需黑名单） | 靠 refresh token 与 introspection |
| 跨服务 | 需共享存储 | 天然适合 | 天然适合 |
| 适合 | 单一 Web 应用 | 微服务内部调用 | 第三方登录、SSO |
| 主要风险 | 固定会话劫持 | 无法撤销、密钥泄露 | 重定向与 scope 配置错误 |

实际项目里常见组合：**对外用 OIDC 登录拿身份，对内用短期 JWT 在服务间传递，权限仍由服务端每次校验。**

### 单点登录怎么串

```
用户 → 门户（OIDC Client）
     → 统一认证中心（IdP，如 Keycloak / 企业微信）
     → 回调带 code → 门户换 token → 建本地 session
其他系统 → 同样跳 IdP，已登录则直接回调（无需再输密码）
```

关键点：**IdP 是唯一真相来源**，各业务系统只保存"本地会话 + 用户标识"，不各自维护账号密码。否则离职账号永远删不干净。

### Token 泄露怎么处理

1. **缩短有效期**：access 15 分钟，refresh 7 天且一次性（refresh 用后即换新的）。
2. **绑定上下文**：token 里带 `client_ip` 或 `device_id`，异常时拒绝（注意移动网络 IP 会变，别绑太死）。
3. **黑名单**：撤销时把 token 的 `jti` 写进 Redis，TTL 设为该 token 的剩余有效期，成本很低。
4. **审计**：记录签发与使用的地理位置/UA，异常同时多地使用就强制下线。

### 几个容易忽视的细节

- **Cookie 要设 `HttpOnly` + `Secure` + `SameSite=Lax`**，前端 JS 读不到才防得住 XSS 偷 token。
- **CSRF 与 cookie 绑在一起**，用 SameSite + 双提交 token 就够，不必上全套。
- **登出必须服务端也失效**，只清前端 localStorage 是假登出。
- **密码登录要有速率限制与失败计数**，不然撞库一天就试穿。
- **`state` 参数**在 OAuth2 里必须校验，否则有 CSRF 风险。

### 一句话总结

选型的判断标准只有两个：**能不能撤销**、**权限变化能不能立刻生效**。这两条过不去，方案再时髦也得改。
