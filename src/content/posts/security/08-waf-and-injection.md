---
title: WAF 与注入防御：把 OWASP Top 10 落到具体配置
description: WAF 三种形态怎么选、规则集怎么调避免误杀、SQL 注入与 XSS 的真实防线在哪一层、四个常见绕过的思路，以及上线后要盯的指标。
date: 2026-11-27
tags: [WAF, 安全, SQL注入, XSS, 防护]
---

### 先说清：WAF 是"最后一道"，不是"第一道"

一个漏洞能否被利用，取决于三层：

```
① 代码层：参数化查询、输出编码、鉴权
② 框架层：ORM、模板引擎、CSRF token
③ 网关层：WAF、限流、IP 信誉
```

**WAF 只能拦"已知模式"，不能替代代码修复。** 把它当唯一防线，等于赌攻击者只用教科书 payload。

### 三种形态

| 形态 | 部署 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 云 WAF | DNS 接入 | 零运维、规则持续更新 | 流量绕第三方、延迟 +10–30ms |
| 反向代理型（ModSecurity/Coraza） | Nginx 前 | 可控、日志在自己手里 | 要自己调规则与性能 |
| 内嵌 SDK（RASP） | 应用进程内 | 能看到运行时上下文 | 有性能开销、语言绑定 |

中小企业最常见：**云 WAF + 应用侧参数化查询**。自建且流量大的：**Coraza/ModSecurity + 自研限流**。

### Nginx + ModSecurity 的最小落地

```nginx
load_module modules/ngx_http_modsecurity_module.so;

server {
    modsecurity on;
    modsecurity_rules_file /etc/nginx/modsec/main.conf;
    ...
}
```

`main.conf`：

```
Include /etc/nginx/modsec/modsecurity.conf
Include /etc/nginx/modsec/crs-setup.conf
Include /etc/nginx/modsec/rules/*.conf
```

`modsecurity.conf` 关键几行：

```
SecRuleEngine On
SecRequestBodyAccess On
SecRequestBodyLimit 13107200
SecResponseBodyAccess Off          # 打开会严重拖性能，先关
SecAuditLog /var/log/modsec/audit.log
SecAuditLogParts ABIJDEFHZ
```

CRS（核心规则集）默认是 **paranoia level 1**，先跑 PL1 观察，再逐步升到 PL2。

### 误杀是最大的落地障碍

WAF 上线第一周最常见的抱怨是"正常请求被 403"。处理顺序：

1. **先 `DetectionOnly` 模式跑一周**，只记录不拦：

```
SecRuleEngine DetectionOnly
```

2. 看 audit log，找出被规则命中的正常请求，逐条加例外：

```
SecRuleRemoveById 942100
SecRuleRemoveById 942100 "id:1001"    # 只对某个 rule id 生效
```

3. 对特定路径放宽（比如富文本编辑器接口）：

```
SecRule REQUEST_URI "@beginsWith /api/v1/editor" "phase:1,id:9001,pass,nolog,ctl:ruleRemoveById=942100"
```

4. 观察 403 率降到接近 0，再切成 `On`。

**规则例外要写注释和工单号**，否则半年后没人知道为什么放过这条。

### SQL 注入：真正的防线在代码

```python
# 错的：拼接
cur.execute("SELECT * FROM users WHERE name = '" + name + "'")

# 对的：参数化
cur.execute("SELECT * FROM users WHERE name = %s", (name,))
```

```java
// 错的
String sql = "SELECT * FROM users WHERE id = " + id;
// 对的
jdbcTemplate.queryForObject("SELECT * FROM users WHERE id = ?", rowMapper, id);
```

WAF 能拦 `union select`、`' or 1=1` 这类明显 payload，但拦不住：

- 编码混淆（`%27`、双 URL 编码、UTF-7）
- 分片注入（把 payload 拆到多个参数）
- 盲注（时间盲注、布尔盲注），流量看起来完全正常

所以三件事必须做：**参数化查询 + 最小权限数据库账号 + 错误信息不外泄**。

数据库账号权限：

```sql
-- 应用账号只给它需要的
GRANT SELECT, INSERT, UPDATE, DELETE ON app_db.* TO 'app'@'10.0.0.%';
-- 绝不给
-- GRANT ALL PRIVILEGES, FILE, SUPER
```

`FILE` 权限可以让攻击者读写服务器文件，`SUPER` 能干太多事，这两条是最该收的。

### XSS：输出编码比过滤输入更靠得住

| 位置 | 正确做法 |
| --- | --- |
| HTML 正文 | HTML 实体编码 |
| 属性值 | 属性编码 + 引号包裹 |
| JS 里 | JS 编码，不要拼字符串 |
| URL 参数 | URL 编码 |

```javascript
// 错的
el.innerHTML = userInput;
// 对的
el.textContent = userInput;
```

再加一层 **CSP**：

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-xxxx'; object-src 'none'; base-uri 'self'
```

CSP 能显著降低 XSS 的成功率，但注意它会让内联脚本失效，上线前要清一遍。

Cookie 侧：

```
Set-Cookie: sid=...; HttpOnly; Secure; SameSite=Lax
```

`HttpOnly` 让 JS 读不到会话，是最便宜的一道保险。

### 三个常见绕过思路（防御视角）

1. **大小写/编码变体**：`SeLeCt`、`%53%45%4c%45%43%54`。规则要归一化后再匹配。
2. **注释插入**：`union/**/select`。正则要容忍注释。
3. **参数污染**：同名参数传多次（`?id=1&id=2`），后端取最后一个，WAF 取第一个。这类要靠框架层统一解析。

知道这些不是为了攻击，而是为了理解"为什么规则会有漏"——所以代码层永远不能省。

### 上线后盯四个指标

```
① 拦截率：被 WAF 拦下的请求占比（突增说明在被打，或规则误杀）
② 误杀率：正常用户收到的 403 比例（核心指标，要 < 0.5%）
③ 响应时间增量：WAF 引入的 P99 增加（应 < 15ms）
④ 规则命中 Top 10：哪些规则最常触发，是否需要调
```

日志侧：

```bash
grep -c 'ModSecurity: Access denied' /var/log/modsec/audit.log
grep 'Access denied' /var/log/modsec/audit.log | grep -oP 'id "\K[0-9]+' | sort | uniq -c | sort -rn | head
```

### 一句话总结

WAF 的价值是**挡住批量扫描与公开 exp**，成本是误杀风险。真正让系统安全的，永远是参数化查询、输出编码、最小权限这三件代码层的事。
