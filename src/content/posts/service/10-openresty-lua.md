---
title: OpenResty：用 Lua 把 Nginx 变成一台可编程的边缘网关
description: 为什么用 OpenResty 而不是写 Nginx 模块、11 个阶段模型、四个能立刻用上的场景（鉴权、限流、灰度、聚合）、共享字典与坑。
date: 2023-03-07
tags: [OpenResty, Nginx, Lua, 网关, 限流]
---

### 什么时候该用它

Nginx 原生配置能做的事（反代、缓存、限流、重写），不要用 Lua。需要 Lua 的典型场景：

1. 鉴权逻辑复杂（多来源 token、按用户查权限）。
2. 响应要动态拼装（多个上游聚合、按参数裁剪字段）。
3. 按业务维度限流（租户配额、按 token 计费）。
4. 灰度要按"用户 ID 哈希 + 白名单"决定。

这些用 Nginx 配置写不出来，写 C 模块成本太高。

### 阶段模型：先搞清"在哪执行"

```
rewrite_by_lua      → 重写阶段（可改 URI）
access_by_lua       → 访问控制（鉴权、限流最佳位置）
content_by_lua      → 生成响应（替代 proxy_pass）
header_filter_by_lua→ 处理响应头
body_filter_by_lua  → 流式处理响应体
log_by_lua          → 记录日志（打点、计费）
balancer_by_lua     → 自定义上游选择（动态负载均衡）
```

最常踩的坑：**在 `content_by_lua` 里想做限流，但此时请求已经进来了**，正确位置是 `access_by_lua`。

### 场景一：统一鉴权

```nginx
location /api/ {
  access_by_lua_block {
    local token = ngx.req.get_headers()["authorization"]
    if not token then
      return ngx.exit(401)
    end

    -- 共享字典缓存鉴权结果，避免每次都查
    local cache = ngx.shared.auth
    local key = "auth:" .. token
    local hit = cache:get(key)
    if hit then
      return
    end

    local http = require "resty.http"
    local client = http.new()
    client:set_timeout(200)
    local res, err = client:request_uri("http://auth-svc/verify", {
      method = "POST",
      body = "token=" .. token,
      headers = { ["Content-Type"] = "application/x-www-form-urlencoded" },
    })
    if not res or res.status ~= 200 then
      return ngx.exit(503)     -- 鉴权服务不可用时"快速失败"
    end
    cache:set(key, true, 60)   -- 缓存 60 秒
  }
  proxy_pass http://backend;
}
```

关键设计：

- **缓存鉴权结果**，否则每个请求都打一次鉴权服务。
- **鉴权服务不可用时返回 503 而不是放行**（fail-closed）。放行是安全漏洞。

### 场景二：按租户限流

```nginx
http {
  lua_shared_dict limits 10m;

  server {
    location /v1/ {
      access_by_lua_block {
        local limit = require "resty.limit.count"
        local tenant = ngx.var.http_x_tenant_id or "anon"

        -- 每租户每分钟 600 次
        local lim, err = limit.new("limits", 600, 60)
        local key = "tenant:" .. tenant
        local delay, excess = lim:incoming(key, true)
        if not delay then
          if excess == "exceed" then
            ngx.header["X-RateLimit-Remaining"] = 0
            return ngx.exit(429)
          end
          return ngx.exit(500)
        end
      }
      proxy_pass http://backend;
    }
  }
}
```

为什么要 `lua_shared_dict`：多 worker 进程共享计数，否则每个 worker 各算一份，实际限流是 N 倍。

按 token 计费的场景更适合 `resty.limit.req`（令牌桶）+ 权重。

### 场景三：灰度分流

```nginx
access_by_lua_block {
  local uid = ngx.var.arg_uid or ngx.var.cookie_uid or "0"
  local pct = 10   -- 10% 流量

  -- 白名单直接命中
  local whitelist = ngx.shared.gray
  if whitelist:get(uid) then
    ngx.var.upstream = "backend_new"
    return
  end

  -- 稳定哈希（同一用户始终一致）
  local hash = ngx.crc32_short(uid)
  if hash % 100 < pct then
    ngx.var.upstream = "backend_new"
  else
    ngx.var.upstream = "backend_old"
  end
}
```

要点：**必须用稳定哈希**，不能随机——否则同一用户会来回切，体验割裂且难以复现问题。

配合 `set $upstream` 与 `proxy_pass http://$upstream`，或 `balancer_by_lua`。

### 场景四：多上游聚合

```nginx
location /dashboard/ {
  content_by_lua_block {
    local http = require "resty.http"

    -- 并行请求三个上游
    local function fetch(url)
      local c = http.new()
      c:set_timeout(300)
      local res = c:request_uri(url)
      return res and res.body or "null"
    end

    -- 简化：实际用 ngx.thread.spawn 并发
    local threads = {
      ngx.thread.spawn(fetch, "http://svc-a/stats"),
      ngx.thread.spawn(fetch, "http://svc-b/stats"),
      ngx.thread.spawn(fetch, "http://svc-c/stats"),
    }
    local results = {}
    for i, th in ipairs(threads) do
      local ok, body = ngx.thread.wait(th)
      results[i] = ok and body or "null"
    end

    ngx.header["Content-Type"] = "application/json"
    ngx.say('{"a":', results[1], ',"b":', results[2], ',"c":', results[3], '}')
  }
}
```

价值：**把 3 次串行 RTT 变成 1 次并行**，前端页面加载从 900ms 降到 320ms。代价是网关承担了聚合逻辑，能力边界要从"转发"变成"轻业务"——要克制，不要在网关里写业务规则。

### 必须知道的三个坑

**① 阻塞式 API 不能用**

`os.execute`、`io.open`（同步文件读）、`socket` 的阻塞调用会**卡住整个 worker**，相当于把 Nginx 变成单线程。

用 `ngx.pipe`、`resty.http`、`ngx.timer.at` 代替。

**② `ngx.shared.DICT` 不是持久存储**

重启即丢，且容量固定（超出会返回 nil 并需要 `flush` 策略）。它适合做计数与短缓存，不能当数据库。

```lua
local dict = ngx.shared.limits
local ok, err = dict:safe_set(key, val, 60)   -- 不覆盖已有值
```

**③ 变量作用域**

```lua
-- 错：每次请求都会重新 require 一次方法，虽然缓存但仍有开销
local ok = require("cjson")
-- 对：模块级 require
```

把 `require` 放在 `init_by_lua`，每次请求只做业务逻辑。

### 一个可用的性能基线

| 场景 | 建议 |
| --- | --- |
| 纯转发 | 不用 Lua，直接 proxy_pass |
| 加鉴权 | 必须有共享字典缓存 |
| 加聚合 | 控制在 3 个上游内，单次超时 < 500ms |
| 限流 | 用 resty 库，不要自己用 `incr` + `expire`（有竞态） |

最后一条尤其重要：手写 `INCR` + `EXPIRE` 在并发下会出现"永远不重置的计数器"，因为 `EXPIRE` 只在第一次执行，且 `INCR` 与 `EXPIRE` 不是原子操作。

```lua
-- 反例：有竞态的限流
local n = redis:incr(key)
if n == 1 then redis:expire(key, 60) end
-- n 在 60 秒后被重置，但极强的并发下可能漏设 expire
```

用 `resty.limit` 系列库，或 Redis 的 `SET key 1 EX 60 NX` + `INCR` 组合（Lua 脚本保证原子）。
