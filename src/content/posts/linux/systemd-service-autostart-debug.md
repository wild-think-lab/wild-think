---
title: systemctl start 失败之后：服务起不来的四层排查法
description: 服务启动失败时，systemctl status 只给一行红字。真正要查的是 unit 解析、依赖顺序、权限与资源四层，按层往下走，比反复重启快。
date: 2026-05-03
tags: [Linux, systemd, 排障, 服务管理]
---

`systemctl start nginx` 失败，屏幕上只有一行 `Job for nginx.service failed`。把它当成入口，而不是结论。

## 一、第一层：unit 有没有被正确解析

配置写错时，systemd 连启动都不会尝试。

```bash
systemctl cat nginx.service          # 实际生效的内容（含 override）
systemd-analyze verify nginx.service # 静态检查：语法、ExecStart 路径、依赖是否存在
```

`systemd-analyze verify` 是最省时间的一步，它能提前发现：

- `ExecStart` 指向的文件不存在或没有执行位；
- `Type=` 与实际进程行为不符（`simple` 配了个会 fork 的守护进程，systemd 会认为主进程退出）；
- `After=` / `Requires=` 引用了不存在的 unit，启动时直接报 `dependency failed`。

排查 override 干扰记住一句：**`systemctl cat` 从上到下依次是主 unit 与各 `*.d/*.conf`，后面的覆盖前面的，不是合并**。同名指令以最后一个为准。

## 二、第二层：依赖顺序真的满足了吗

`dependency failed` 意味着某个 `Requires=` 的 unit 挂了，而不是本服务有问题。

```bash
systemctl list-dependencies --reverse nginx.service   # 谁依赖我
systemctl list-dependencies nginx.service             # 我依赖谁
journalctl -u nginx.service -b --no-pager | tail -40
```

常见坑：

| 现象 | 原因 |
| --- | --- |
| 启动瞬间就 failed | `Requires=` 的 unit 未启动 |
| 启动成功但端口没监听 | 网络未就绪，缺 `After=network-online.target` |
| 数据库客户端连不上 | 只写了 `After=` 没写 `Wants=`，对方根本没被拉起 |
| 重启系统后不自启 | 只 `start` 了，没有 `enable` |

`network.target` 只表示网络栈已加载，**不保证网卡拿到地址**。要等地址就绪必须用 `network-online.target`，且系统上得有等网络的服务（`NetworkManager-wait-online` 或 `systemd-networkd-wait-online`）真正启用。

## 三、第三层：权限与文件描述符

systemd 拉起的是无登录 shell、无继承环境、受限权限的进程，手工在 shell 里跑得通不代表服务能跑通。

```bash
# 用服务的身份跑一次，复现权限问题
sudo -u www-data /usr/sbin/nginx -t

# 看它的安全沙箱限制
systemctl show nginx.service -p ProtectSystem -p PrivateTmp -p NoNewPrivileges -p ReadWritePaths
```

高频原因：

1. **工作目录**：`WorkingDirectory=` 未设置，相对路径全部落到 `/`。
2. **环境变量**：手工 `export` 的变量在服务里不存在，需写进 `Environment=` 或 `EnvironmentFile=`。
3. **写权限**：`ProtectSystem=strict` 下 `/usr`、`/boot` 只读，日志/缓存目录必须显式加进 `ReadWritePaths=`。
4. **端口权限**：非 root 绑 80/443 需要 `CAP_NET_BIND_SERVICE` 或 `AmbientCapabilities=`。
5. **SELinux / AppArmor**：`ausearch -m avc -ts recent` 或 `dmesg | grep -i denied` 能看到拒绝记录，`setenforce 0` 仅用于确认因果，不要留在生产。

## 四、第四层：资源与内核限制

进程起来了又被内核杀掉，日志里通常有 `status=...` 的退出码。

| 退出码 | 含义 | 处理 |
| --- | --- | --- |
| 1 / 2 | 应用自身报错 | 看应用日志，不是 systemd 问题 |
| 203 | ExecStart 不可执行 | 权限位 / shebang / 文件系统挂载为 noexec |
| 226 | ExecStart 执行失败 | 路径不存在、缺动态库（`ldd` 查） |
| 137 (SIGKILL) | 被 OOM 或 stop 超时强杀 | `dmesg -T | grep -i oom`；调 `MemoryMax` 或 `TimeoutStopSec` |
| 143 (SIGTERM) | 正常停止信号 | 通常不是故障 |

被 OOM 杀掉时 `systemctl status` 只显示 `killed`，必须看 `dmesg` 才有 `Out of memory: Killed process`。容器里同样成立：容器内存上限低于应用峰值，表现也是 137。

文件描述符不够则是另一类：

```bash
systemctl show nginx.service -p LimitNOFILE
cat /proc/$(systemctl show -p MainPID --value nginx.service)/limits | grep 'open files'
```

`LimitNOFILE=` 写在 unit 里才会对服务生效，改 `/etc/security/limits.conf` 对 systemd 服务**无效**。

## 五、一份可复用的排查脚本

```bash
svc=$1
systemd-analyze verify "$svc" 2>&1
systemctl status "$svc" --no-pager -l | head -12
journalctl -u "$svc" -b -n 60 --no-pager
systemctl show "$svc" -p ExecStart -p User -p WorkingDirectory -p Restart -p LimitNOFILE
```

四层按顺序走：**解析 → 依赖 → 权限 → 资源**。跳层排查的典型表现是"改了三个地方，最后发现是拼错路径"。

> 一句经验：`systemd-analyze verify` + `journalctl -u <svc> -b` 这两条命令覆盖了八成启动失败；剩下两成里，退出码 203/226 查路径与库，137 查内存。
