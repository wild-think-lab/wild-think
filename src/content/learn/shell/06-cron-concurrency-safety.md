---
title: 定时、并发与安全边界：脚本上生产前的最后一关
module: 熟练篇
summary: cron 与 systemd timer 怎么选、并发执行如何防重入、危险操作为什么一定要先 dry-run。学完能把脚本放心放进生产。
minutes: 13
---

### 上生产前的四个问题

1. 它什么时候跑？失败了谁知道？
2. 上一次没跑完，下一次会不会叠在一起？
3. 它会不会误删东西？
4. 出问题怎么回滚？

能答上这四个，脚本才算"能上线"。

### 定时：cron 与 timer

**cron**：

```bash
crontab -e
0 3 * * * /usr/bin/flock -n /var/lock/backup.lock /opt/scripts/backup.sh >> /var/log/backup.log 2>&1
```

三个必要成分：`flock -n`（防重入）、`>>`（留输出）、绝对路径（cron 的 PATH 极短）。

**systemd timer**（推荐）：

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Nightly backup

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now backup.timer
systemctl list-timers --all
journalctl -u backup.service -n 50
```

优势：错过会补跑（`Persistent`）、输出自动进 journal、失败可触发 `OnFailure=`。

### 防重入：两种写法

**文件锁（跨进程可靠）**：

```bash
exec 9>/var/lock/mytask.lock
flock -n 9 || { echo "已有实例在跑"; exit 0; }
```

`exec 9>file` 打开文件描述符，`flock -n 9` 加非阻塞锁。脚本退出时锁自动释放，比手写 PID 文件安全。

**PID 文件（简单但易残留）**：

```bash
[ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && { echo "running"; exit 0; }
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT
```

机器非正常重启后 PID 文件会残留，所以需要 `kill -0` 校验进程是否存在。

### 并发执行：限流避免打爆下游

```bash
#!/usr/bin/env bash
set -euo pipefail

MAX=5
running=0

for h in $(cat hosts.txt); do
  ( check_host "$h" ) &
  running=$((running + 1))
  if [ "$running" -ge "$MAX" ]; then
    wait -n          # 等任意一个结束
    running=$((running - 1))
  fi
done
wait
```

`wait -n` 是 bash 4.3+ 的用法；更老的版本可以用 `xargs -P`：

```bash
xargs -P 5 -I{} ssh {} uptime < hosts.txt
```

**不要无限制并发**。200 台机器同时 SSH，网络和 sshd 都会抗议。

### 危险操作的三道闸

**第一道：明示目标**

```bash
target=${1:?用法: $0 <目录>}
case "$target" in
  /|/etc|/usr|/var) die "拒绝对系统目录操作: $target" ;;
esac
```

`${1:?}` 是"参数缺失就报错退出"，比手动 `if [ -z ]` 短。

**第二道：dry-run**

```bash
DRY=${DRY:-yes}
run() {
  if [ "$DRY" = "yes" ]; then echo "[dry] $*"; else "$@"; fi
}
run rm -rf "$target"
```

默认 dry-run，确认后 `DRY=no` 再执行。这是最省事故成本的设计。

**第三道：先备份再删除**

```bash
mv "$target" "${target}.bak.$(date +%s)"
```

比 `rm -rf` 慢一步，但能救你一次。

### 信号与清理

```bash
cleanup() {
  rm -f "$tmpdir"/*.part
  info "已清理临时文件"
}
trap cleanup EXIT INT TERM
```

`trap ... EXIT` 保证无论正常结束还是被 Ctrl+C，清理都会执行。

### 权限与环境

- 定时任务用专用用户（如 `backup`），不要用 root 跑所有脚本。
- 需要 sudo 的命令在 `/etc/sudoers.d/` 里精确授权到命令级。
- 脚本里所有路径写绝对路径，别依赖当前目录。
- 需要特定 locale 的输出（如日期格式），显式设 `LC_ALL=C`。

### 上线检查清单

```
[ ] 有 shebang + set -euo pipefail
[ ] 参数有校验，错误有 usage
[ ] 有文件锁防重入
[ ] 有 dry-run 开关
[ ] 日志含开始/结束/耗时
[ ] 失败返回非 0
[ ] 定时任务有 flock，输出有重定向
[ ] 有 trap 清理临时文件
[ ] 危险命令有路径白名单
```

### 本章验证

1. 给上一章的脚本加 `flock` 防重入，同时手动跑两次验证第二次直接退出。
2. 用 `xargs -P 5` 并发检查 10 台机器，观察耗时差异。
3. 给删除操作加 dry-run，默认只打印。

到这里，Shell 这条线就走完了：**能写、能判断、能记日志、能定时、不会误伤**。下一步是把这些能力接到 Ansible、CI 流水线上，让它们从"一个人的脚本"变成"一个团队的工具"。
