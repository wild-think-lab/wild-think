---
title: 端口与 TCP：连接是怎么建立的
module: 基础篇
summary: 端口是"程序的门牌号"，三次握手解释了为什么会有 connection refused 和 timeout 两种截然不同的报错。
minutes: 18
---

### 端口：同一台机器上区分不同程序

一台机器只有一个 IP，但可以同时跑 nginx（80）、SSH（22）、MySQL（3306）。区分它们的就是**端口**。

| 端口段 | 用途 | 例子 |
| --- | --- | --- |
| 0–1023 | 系统保留 | 22 SSH、80 HTTP、443 HTTPS |
| 1024–49151 | 注册端口 | 3306 MySQL、6379 Redis、8080 应用 |
| 49152+ | 临时端口 | 客户端发起连接时随机分配 |

**服务端监听**某个端口等人连；**客户端**用随机高位端口去连它。所以 `ss -lntp` 看的是"我在等谁"。

### 一次 TCP 连接：三次握手

```text
客户端                        服务端
   ──── SYN ──────────────────→    我想连你
   ←─── SYN+ACK ───────────────    好，我也准备好了
   ──── ACK ──────────────────→    确认
   （连接建立，开始传数据）
```

断开要四次挥手。日常排错只需知道：**握手没走完，就没有连接**。

### 两种报错，原因完全不同

| 现象 | 含义 | 说明 |
| --- | --- | --- |
| `Connection refused` | 包到了，对方回了 RST | 机器活着，但那个端口**没有程序在听** |
| `Connection timed out` | 包发出去没回应 | 路径上有东西把包丢了：防火墙、安全组、路由 |
| `No route to host` | 根本到不了 | 路由/网段配错 |

这个区分极重要：

- **refused → 查服务**：`systemctl status`、`ss -lntp`，是不是没启动或监听了别的端口。
- **timeout → 查网络**：防火墙规则、云安全组、目标 IP 是否正确。

分不清这两种，就会在"服务其实正常"的机器上反复重启。

### TCP 与 UDP

| | TCP | UDP |
| --- | --- | --- |
| 是否建立连接 | 是（三次握手） | 否，直接发 |
| 是否保证顺序与完整 | 保证，丢了重传 | 不保证 |
| 典型用途 | HTTP、SSH、数据库 | DNS、音视频、监控上报 |

一句话：**要准确用 TCP，要快要及时用 UDP**。

### 验证端口是否通

```bash
ss -lntp                       # 本机在监听什么
ss -lntp | grep :80
nc -vz 10.0.0.5 3306           # 从外部测某个 IP 的某个端口
curl -I http://10.0.0.5        # 测应用层
```

Windows 没 `nc` 可以用 PowerShell 的 `Test-NetConnection`：

```powershell
Test-NetConnection 10.0.0.5 -Port 3306
```

### 防火墙：最常见的"端口通不了"

```bash
sudo firewall-cmd --list-all               # firewalld（RHEL 系）
sudo firewall-cmd --add-port=8080/tcp --permanent
sudo firewall-cmd --reload

sudo ufw status                            # ufw（Ubuntu）
sudo ufw allow 8080/tcp
```

云服务器还有一层**安全组**，在控制台里配，和本机防火墙是两套独立的开关。**两个都放行才通**——这是"本机一切正常，外部就是连不上"的最常见原因。

### 自己验证

```bash
ss -lntp | grep :22        # SSH 一定在听
nc -vz 127.0.0.1 22        # 本机测通
nc -vz 127.0.0.1 9999      # 测一个没开的端口，看 refused 长什么样
```

亲眼看到 `refused` 和 `timed out` 的区别，比记定义有用。

### 本章小结

- 端口是程序的门牌号，服务端监听、客户端随机分配。
- refused = 没人听，timeout = 包被丢，两者排查方向相反。
- TCP 保证完整，UDP 追求快。
- 云上不通，先查安全组，再查本机防火墙。

**下一章**：DNS——域名是怎么变成 IP 的。
