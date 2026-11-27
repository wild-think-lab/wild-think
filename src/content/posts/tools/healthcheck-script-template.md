---
title: 脚本模板：一份能直接用的 Linux 巡检脚本
description: 巡检脚本的价值是"结构统一、指标可比"，不是堆命令。这份模板给出收敛的输出格式、阈值判断与结构化落盘，可直接改成你要的项。
date: 2026-10-14
tags: [Shell, 脚本, 巡检, 运维, 模板]
---

巡检脚本的常见毛病：一堆命令拼起来、输出无法对比、跑完还得人肉看。更好的做法是**固定输出格式 + 明确阈值 + 机器可读的落盘**。

## 一、骨架约定

```bash
#!/bin/bash
# 巡检脚本骨架：每个检查项 = 一个函数，统一输出格式
set -uo pipefail

REPORT_DIR=/var/log/healthcheck
STAMP=$(date +%F_%H%M)
mkdir -p "$REPORT_DIR"
OUT="$REPORT_DIR/$(hostname)_$STAMP.txt"

ok()   { echo "[OK]   $*" | tee -a "$OUT"; }
warn() { echo "[WARN] $*" | tee -a "$OUT"; }
crit() { echo "[CRIT] $*" | tee -a "$OUT"; }
info() { echo "[INFO] $*" | tee -a "$OUT"; }

echo "== 巡检报告 $(hostname) $(date '+%F %T') ==" > "$OUT"
```

三个级别对应三种处置：`OK` 正常、`WARN` 需关注、`CRIT` 需立即处理。**输出必须带上前缀，后面才能被 grep 或采集器解析。**

## 二、六类检查项

### 1. 负载与 CPU

```bash
check_load() {
  local l1 l5 l15 cores
  read -r l1 l5 l15 _ < /proc/loadavg
  cores=$(nproc)
  # 经验阈值：1 分钟负载 > 核心数 × 1.0 关注，> ×2 告警
  awk -v l="$l1" -v c="$cores" 'BEGIN{exit !(l > c*2)}' \
    && crit "load1=$l1 > 2x cores($cores)" || info "load1=$l1 cores=$cores l5=$l5 l15=$l15"
}
```

注意 `nproc` 在容器里看到的是宿主机核数，容器环境应改用 cgroup 的 `cpu.max`。

### 2. 内存

```bash
check_mem() {
  local avail total
  avail=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  total=$(awk '/MemTotal/{print $2}' /proc/meminfo)
  local pct=$((avail * 100 / total))
  if   [ "$pct" -lt 10 ]; then crit "available ${pct}% (${avail}KB/${total}KB)"
  elif [ "$pct" -lt 20 ]; then warn "available ${pct}%"
  else info "available ${pct}%"
  fi
}
```

**用 `MemAvailable` 而不是 `MemFree`**，否则 page cache 会让每台机器都显示"内存告急"。

### 3. 磁盘与 inode

```bash
check_disk() {
  df -P | awk 'NR>1 && $5+0 >= 80 {print $6, $5}' | while read -r mp pct; do
    [ "${pct%\%}" -ge 90 ] && crit "disk $mp used $pct" || warn "disk $mp used $pct"
  done
  df -Pi | awk 'NR>1 && $5+0 >= 80 {print $6, $5}' | while read -r mp pct; do
    warn "inode $mp used $pct"
  done
}
```

两块都要查：`df -h` 看空间，`df -i` 看 inode。只查前者会漏掉"小文件写满 inode"的故障。

### 4. 关键进程与服务

```bash
SERVICES=(sshd crond rsyslog)
check_services() {
  for s in "${SERVICES[@]}"; do
    if systemctl is-active --quiet "$s"; then info "service $s active"
    else crit "service $s NOT active"
    fi
  done
}
```

用清单驱动，而不是硬编码一堆 `ps -ef | grep`（后者会把自己 grep 进去）。

### 5. 网络与端口

```bash
check_net() {
  ss -lnt | awk 'NR>1{print $4}' | awk -F: '{print $NF}' | sort -n | uniq -c \
    | awk '{printf "%s(%s) ", $2, $1} END{print ""}'
  # 连通性抽查（示例：网关）
  local gw; gw=$(ip route show default | awk '{print $3; exit}')
  [ -n "$gw" ] && (ping -c 2 -W 1 "$gw" >/dev/null && info "gateway $gw reachable" \
                  || crit "gateway $gw UNREACHABLE")
}
```

### 6. 安全与证书

```bash
check_security() {
  local failed; failed=$(lastb 2>/dev/null | wc -l)
  [ "$failed" -gt 50 ] && warn "failed logins last 24h: $failed" || info "failed logins: $failed"

  # 证书剩余天数（有 cert 的机器才跑）
  for c in /etc/pki/tls/certs/*.pem; do
    [ -f "$c" ] || continue
    local d; d=$(( ($(date -d "$(openssl x509 -in "$c" -noout -enddate | cut -d= -f2)" +%s) - $(date +%s)) / 86400 ))
    [ "$d" -lt 15 ] && warn "cert $c expires in ${d}d"
  done
}
```

## 三、主流程与退出码

```bash
main() {
  check_load
  check_mem
  check_disk
  check_services
  check_net
  check_security
  if grep -q '\[CRIT\]' "$OUT"; then
    info "结果：存在 CRIT，见 $OUT"; exit 2
  elif grep -q '\[WARN\]' "$OUT"; then
    info "结果：存在 WARN，见 $OUT"; exit 1
  else
    info "结果：全部正常，见 $OUT"; exit 0
  fi
}
main
```

退出码让脚本能被监控系统直接调用（0 正常 / 1 警告 / 2 严重），这比"发一封没人看的邮件"有用得多。

## 四、定时与轮转

```bash
# /etc/cron.d/healthcheck
SHELL=/bin/bash
0 */4 * * * root /usr/local/bin/healthcheck.sh >/dev/null 2>&1
```

```conf
# /etc/logrotate.d/healthcheck
/var/log/healthcheck/*.txt {
    daily
    rotate 14
    compress
    missingok
    notifempty
}
```

## 五、三条实践原则

1. **任何阈值都要写成常量或参数**，不要在命令里写魔法数字。
2. **每项检查都必须能独立运行**（`bash -x` 单测某个函数），否则上线后无法定位是哪项卡住。
3. **脚本自己不能成为风险源**：不 `rm`、不重启服务、不改配置。巡检只读。

> 一个成熟巡检脚本的标志是：**输出能被 diff**。两次报告一比，就能看出趋势，这比任何单次检查都有价值。
