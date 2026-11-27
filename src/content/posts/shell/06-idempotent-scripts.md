---
title: 幂等脚本：让脚本"跑两次也不会出事"
description: 幂等与"能重跑"的差别、五类操作的幂等写法、状态检查的三种手段，以及"半成功"状态怎么处理。
date: 2023-03-11
tags: [Shell, 幂等, 自动化, 运维]
---

### 为什么幂等重要

运维脚本最常见的场景不是"跑一次"，而是：

```
① 跑到一半失败了，要再跑一次
② 定时任务每天跑，昨天已经跑过
③ 两个人都点了"执行"
```

**不幂等的脚本，第二次跑就可能造成故障**（重复创建、覆盖数据、重复写配置）。

### 幂等 ≠ 能重跑

| | 能重跑 | 幂等 |
| --- | --- | --- |
| 第二次执行 | 不报错 | **结果与第一次相同** |
| 例子 | `mkdir -p` | `mkdir -p` 且不改变已有目录的权限 |

`mkdir -p` 是幂等的；但 `useradd alice` 第二次会报错（不幂等），而"如果不存在就创建"是幂等的。

### 五类操作的幂等写法

**① 创建资源**

```bash
# 幂等：存在则跳过
if [[ ! -d /opt/app ]]; then
  mkdir -p /opt/app
fi
# 或
mkdir -p /opt/app
```

**② 用户与权限**

```bash
id alice &>/dev/null || useradd -m -s /bin/bash alice
grep -q '^alice ' /etc/sudoers.d/ops 2>/dev/null || echo 'alice ALL=(ALL) NOPASSWD:/bin/systemctl' > /etc/sudoers.d/ops
```

**③ 配置文件（最关键）**

```bash
# 差：每次都追加，跑 N 次就有 N 行
echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf

# 好：先删后加（或先判断）
sed -i '/^net.ipv4.ip_forward/d' /etc/sysctl.conf
echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf

# 更好：整块用标记包裹，可替换
if grep -q '# BEGIN app' /etc/nginx/nginx.conf; then
  sed -i '/# BEGIN app/,/# END app/d' /etc/nginx/nginx.conf
fi
cat >> /etc/nginx/nginx.conf <<'EOF'
# BEGIN app
include /etc/nginx/conf.d/*.conf;
# END app
EOF
```

**④ 服务状态**

```bash
# 幂等：不管当前状态，达到目标状态
systemctl enable --now nginx
# 或需要重启才生效时
systemctl is-active --quiet nginx || systemctl start nginx
```

**⑤ 数据库变更**

```sql
-- 幂等：判断后再建
CREATE TABLE IF NOT EXISTS orders (...);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- 加字段（没有 IF NOT EXISTS 语法，要先查）
-- 用迁移工具（Flyway/Liquibase）管理版本
```

### 状态检查的三种手段

**① 检查"结果是否存在"**

```bash
[[ -f /opt/app/.installed ]] || do_install
```

**② 检查"服务是否在跑"**

```bash
curl -sf http://127.0.0.1:8080/health >/dev/null || restart_service
```

**③ 检查"内容是否一致"**

```bash
if ! diff -q <(echo "$EXPECTED") "$CONF_FILE" >/dev/null; then
  echo "$EXPECTED" > "$CONF_FILE"
  reload_service
fi
```

**② 和 ③ 更可靠**：① 标记文件容易被"半成功"骗过。

### "半成功"状态怎么处理

**场景**：脚本做三件事（装包、写配置、起服务），第二件失败退出。

```
状态：包装好了，配置没写，服务没起
```

下次重跑时：

```
装包：已安装 → 跳过（幂等 OK）
写配置：重新写（幂等 OK）
起服务：启动（幂等 OK）
→ 自动修复
```

**这就是幂等的价值**：不需要"回滚到干净状态"，只要每步都是"确保达到目标状态"，重跑一次就自愈。

**反例**：脚本用"步骤编号 + 状态文件"记录进度（`step=2`），一旦状态文件与实际不符就会跳过本该做的事。

### 并发保护

```bash
exec 9>/var/run/deploy.lock
flock -n 9 || { echo "another deploy running"; exit 1; }
```

**两个定时任务叠加执行**是最常见的并发问题（上一次没跑完，下一次开始了）。

### 一个幂等的完整模板

```bash
#!/usr/bin/env bash
set -euo pipefail

PKG=nginx
CONF=/etc/nginx/conf.d/app.conf
SVC=nginx

ensure_pkg() {
  if ! dpkg -s "$PKG" &>/dev/null; then
    apt-get update -qq && apt-get install -y "$PKG"
  fi
}

ensure_conf() {
  local tmp; tmp=$(mktemp)
  cat >"$tmp" <<'EOF'
server {
    listen 8080;
    location / { return 200 "ok\n"; }
}
EOF
  if ! cmp -s "$tmp" "$CONF"; then
    install -m 644 "$tmp" "$CONF"
    nginx -t
    CHANGED=1
  fi
  rm -f "$tmp"
}

ensure_service() {
  systemctl enable "$SVC" &>/dev/null || true
  if [[ "${CHANGED:-0}" == "1" ]] || ! systemctl is-active --quiet "$SVC"; then
    systemctl restart "$SVC"
  fi
}

ensure_pkg
ensure_conf
ensure_service
echo "done"
```

跑第二次时：包已装（跳过）、配置一致（跳过）、服务在跑（跳过）→ **真正幂等**。

### 检查清单

```
□ 创建资源用"存在则跳过"
□ 配置文件用"先删后加"或"内容比对"
□ 服务用 `enable --now` 或"检查后再启"
□ 数据库用 IF NOT EXISTS / 迁移工具
□ 有 flock 防并发
□ 每步都是"确保达到目标状态"，而不是"记录第几步"
```
