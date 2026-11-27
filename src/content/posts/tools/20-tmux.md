---
title: tmux 与 screen：把"网络断了任务就死"变成历史
description: 五个必会操作、断线恢复、多人共享会话，以及五个"用了 tmux 还是丢任务"的原因。
date: 2026-11-27
tags: [工具, tmux, Linux]
---

### 为什么必须用

```
SSH 断开 → 前台进程收到 SIGHUP → 任务死
tmux 让进程活在"会话"里，与 SSH 连接解耦
```

**"跑了 3 小时的迁移，网断了"** 是必须避免的经典事故。

### 五个必会操作

```bash
tmux new -s work          # 新建会话
tmux ls                   # 列表
tmux attach -t work       # 进入
# 前缀键 Ctrl-b
Ctrl-b d                  # 分离（detach）
Ctrl-b c                  # 新建窗口
Ctrl-b n / p              # 下/上窗口
Ctrl-b %                  # 左右分屏
Ctrl-b "                  # 上下分屏
Ctrl-b 方向键             # 切窗格
```

**"分离（detach）"** 是关键动作：`Ctrl-b d` 后进程继续跑。

### 断线恢复

```bash
# 重新登录后
tmux ls
tmux attach -t work
```

**"attach 后看到滚动历史"**：

```
Ctrl-b [ 进入复制模式，方向键/PageUp 翻页，q 退出
```

### 多人共享会话

```bash
# A 建会话
tmux new -s pair
# B 加入（同一台机器，同一用户）
tmux attach -t pair
```

**用途**：

```
结对排障（两人看同一屏幕）
交接（新人看老人操作）
```

**注意**：

```
默认"两人输入会互相干扰"（都在同一窗格）
→ 各开一个窗格再共享
```

### 五个"用了 tmux 还是丢任务"

**① 在 tmux 里又开了"前台阻塞命令"然后 detach**

```
detach 不会杀进程 → 任务继续
但如果"服务器重启" → 会话全没
```

**"重启就没了"** → 长期任务要用 systemd/nohup 或"重连后自动恢复"。

**② 用了 tmux 但"忘记 detach"就关终端**

```
关终端（非 SSH 断开）→ 有些终端会杀进程组
→ 先 Ctrl-b d 再关
```

**③ 会话里跑了"需要 tty"的程序**

```
某些程序（如交互式安装）在 detach 后卡住
→ 用 `-d`（分离模式）或不 detach
```

**④ 权限/多用户混乱**

```
root 会话被普通用户 attach（socket 权限）
```

**⑤ 服务器重启后不知道有会话**

```
需要在"启动时自动建会话"（systemd unit 跑 tmux）
```

### 一个"长期任务"的正确姿势

```bash
# 方案 A：systemd（最稳，重启也能起）
cat > /etc/systemd/system/migrate.service <<'EOF'
[Service]
Type=oneshot
ExecStart=/usr/local/bin/migrate.sh
EOF
systemctl start migrate

# 方案 B：tmux + 日志文件
tmux new -d -s migrate 'bash /usr/local/bin/migrate.sh 2>&1 | tee /var/log/migrate.log'
```

**"日志落文件"** 才不会因为会话丢了而看不到进度。

### tmux 配置（.tmux.conf）

```conf
set -g mouse on
set -g history-limit 50000
set -g base-index 1
setw -g pane-base-index 1
set -g status-right '%Y-%m-%d %H:%M'
bind r source-file ~/.tmux.conf \; display "reloaded"
```

**"history-limit 50000"** 让滚动历史足够长（排查时很有用）。

### 检查清单

```
□ 会用 new/ls/attach/detach
□ 会话命名（不只 "0"）
□ 长期任务配日志落文件
□ 关键任务用 systemd（不依赖会话）
□ 会翻滚动历史（复制模式）
□ 多人共享时各开窗格
□ 有 .tmux.conf（mouse/历史长度）
□ 重启后知道怎么恢复
□ 不在会话里跑"必须前台"的交互程序
```
