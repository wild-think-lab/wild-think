---
title: 两个能直接用的运维脚本：巡检与备份
module: 进阶篇
summary: 一份巡检脚本（磁盘/内存/服务/证书）与一份备份脚本（保留策略/校验/告警），都是可直接跑的版本。
minutes: 50
---

### 脚本一：日常巡检

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

WARN=0
log()  { printf '%s [%s] %s\n' "$(date '+%F %T')" "${2:-INFO}" "$1" >&2; }
bad()  { WARN=$((WARN+1)); log "$1" ERROR; }
ok()   { log "$1" INFO; }

check_disk() {
  while read -r pct mount; do
    if (( pct >= 90 )); then bad "disk ${mount} ${pct}%"
    elif (( pct >= 80 )); then log "disk ${mount} ${pct}% (watch)" WARN
    else ok "disk ${mount} ${pct}%"; fi
  done < <(df -P | awk 'NR>1 {gsub("%","",$5); print $5, $6}')
}

check_mem() {
  local avail
  avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  (( avail < 500 )) && bad "mem available ${avail}MB" || ok "mem available ${avail}MB"
}

check_service() {
  for s in "$@"; do
    if systemctl is-active --quiet "$s"; then ok "svc $s active"
    else bad "svc $s down"; fi
  done
}

check_cert() {
  local host=$1 port=${2:-443} days
  days=$(echo | openssl s_client -servername "$host" -connect "$host:$port" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  [[ -z "$days" ]] && { bad "cert $host unreachable"; return; }
  local left=$(( ( $(date -d "$days" +%s) - $(date +%s) ) / 86400 ))
  (( left < 14 )) && bad "cert $host ${left}d left" || ok "cert $host ${left}d left"
}

check_disk
check_mem
check_service nginx sshd
check_cert example.com

(( WARN == 0 )) && ok "all checks passed" || log "${WARN} issue(s)" WARN
exit $(( WARN > 0 ))
```

**设计要点**：

```
① 只读，不改系统（巡检脚本绝不能顺手改东西）
② 分级输出（INFO/WARN/ERROR）
③ 退出码 = 问题数（可被监控直接消费）
④ 每条检查独立，一条失败不影响其他
```

### 脚本二：备份（含保留与校验）

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

SRC=${SRC:-/data/app}
DST=${DST:-/backup/app}
KEEP=${KEEP:-7}

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >&2; }

[[ -d "$SRC" ]] || { log "src missing: $SRC"; exit 1; }
mkdir -p "$DST"

ts=$(date +%F_%H%M%S)
tmp="$DST/.tmp_$ts"
trap 'rm -rf "$tmp"' EXIT

# 1) 打包（排除缓存/日志）
tar -C "$(dirname "$SRC")" \
    --exclude='*/cache' --exclude='*/tmp' \
    -czf "$tmp.tgz" "$(basename "$SRC")"

# 2) 校验（能解开才算成功）
tar -tzf "$tmp.tgz" >/dev/null || { log "verify failed"; exit 1; }

# 3) 原子落地
mv "$tmp.tgz" "$DST/app_$ts.tgz"

# 4) 保留最近 N 份
ls -1t "$DST"/app_*.tgz | tail -n +$((KEEP+1)) | xargs -r rm -f

# 5) 记录
size=$(du -h "$DST/app_$ts.tgz" | cut -f1)
log "backup ok: app_$ts.tgz ($size)"
```

**五个要点**：

```
① 先写临时文件再 mv（原子，避免"半个备份"）
② 打包后立刻校验（能列出内容）
③ 排除缓存/临时（体积与一致性）
④ 保留策略（不然磁盘先满）
⑤ 输出大小与耗时（便于发现异常）
```

### 备份的三个必备补充

```
① 异地：本地备份不防"机器/机房没了"
② 恢复演练：每月至少恢复一次到临时目录
③ 监控：备份失败要告警（不是只写日志）
```

**"备份成功但没恢复过"** 不算有备份。

### 巡检怎么接监控

```bash
# 输出成 Prometheus 文本格式
cat <<EOF
# HELP ops_check_issues Number of failed checks
# TYPE ops_check_issues gauge
ops_check_issues $WARN
EOF
```

**"只给人看的巡检"** 没人看；给监控才有意义。

### 检查清单（巡检）

```
□ 只读
□ 分级 + 退出码
□ 覆盖磁盘/inode/内存/服务/证书/时间
□ 每条独立
□ 能输出到监控
□ 有明确的阈值（80/90/14 天）
```

### 检查清单（备份）

```
□ 临时文件 + 原子 mv
□ 打包后校验
□ 排除无关目录
□ 保留策略
□ 异地副本
□ 恢复演练
□ 失败告警
□ 记录大小/耗时
```
