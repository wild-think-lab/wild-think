---
title: DNS 解析慢或解析错：把一条查询链路拆成六段来查
description: 应用连不上时先怀疑网络是冤枉的。域名解析要经过 nsswitch、本地缓存、resolv.conf、递归服务器、权威服务器五道关，每段都有各自的可观测点。
date: 2026-11-24
tags: [网络, DNS, 排障, Linux]
---

`getent hosts api.example.com` 卡 5 秒然后失败，`ping` 也一样，但 `ping 10.0.0.9` 秒通。这时候别再查网卡了，问题在解析链路。

## 一、六段链路与对应命令

```text
应用
 └─ getaddrinfo()          ← 应用层（连接池、超时设置）
     └─ nsswitch.conf      ← 决定走 files / dns / myhostname
         └─ /etc/hosts     ← 静态覆盖，优先级最高
             └─ 本地缓存   ← systemd-resolved、nscd、dnsmasq
                 └─ resolv.conf ← 用哪个递归服务器、超时、重试
                     └─ 递归服务器 → 权威服务器
```

| 段 | 观测手段 |
| --- | --- |
| 应用层 | 应用日志里的解析耗时、连接超时值 |
| nsswitch | `cat /etc/nsswitch.conf | grep hosts` |
| hosts | `cat /etc/hosts` |
| 本地缓存 | `systemctl status systemd-resolved`、`resolvectl status` |
| resolv.conf | `cat /etc/resolv.conf`、`resolvectl statistics` |
| 递归/权威 | `dig +trace`、`dig @8.8.8.8` |

**第一步永远是 `getent hosts`**，不是 `dig`。`dig` 绕过 nsswitch 直接问 DNS，能通不能证明应用能通；`getent` 走的是和应用程序完全相同的路径。

```bash
getent hosts api.example.com     # 走完整链路，和应用一致
dig api.example.com +short       # 直连 DNS，跳过 hosts 与 nsswitch
```

两者结果不一致 → 问题在 hosts、nsswitch 或本地缓存，与 DNS 服务器无关。

## 二、resolv.conf 里最容易埋的三个雷

```ini
nameserver 10.0.0.2
nameserver 114.114.114.114
options timeout:1 attempts:2
search corp.example.com
```

1. **`search` 域导致多余查询**：查 `api` 时会先试 `api.corp.example.com`，每次多一轮 RTT；若内网 DNS 对未知域返回 NXDOMAIN 慢，整体会翻倍。
2. **多个 nameserver 不是负载均衡，是串行重试**：第一个不响应要等到超时（默认 5s）才试第二个。`timeout:1 attempts:2` 能把最坏情况从 30s 压到 4s 左右。
3. **`options rotate` 慎用**：轮询会让缓存命中率下降，某些递归服务器对突发查询限速。

容器里还要多一层：Docker 默认把宿主 `resolv.conf` 拷进去，`ndots:5` 会让 `api.example.com` 这种带点的名字先按相对名查一遍。K8s 里表现为"DNS 解析偶发 5 秒延迟"，这是 `ndots` 与 `search` 域名叠加的经典组合。

```yaml
# Pod 级别修正
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"
```

## 三、区分"解析慢"和"解析错"

```bash
dig api.example.com +stats        # 看 Query time，正常内网 < 5ms
dig api.example.com +trace        # 从根开始逐级，看哪一级卡住
dig @10.0.0.2 api.example.com     # 指定服务器，排除本地配置
```

- **耗时高、结果对**：递归服务器慢、或走了不通的 IPv6。`dig AAAA` 单独试一次，很多"随机 5 秒"是 AAAA 查询超时（`/etc/gai.conf` 可调优先级）。
- **耗时可、结果错**：split-horizon（内外网返回不同地址）、权威记录未更新、TTL 未过期。
- **时好时坏**：多台递归服务器配置不一致、或者 DNS 轮询返回了不可达的节点。

## 四、缓存取证的顺序

改了解析却不生效，按 TTL 从短到长清：

```bash
resolvectl flush-caches                 # systemd-resolved
sudo systemd-resolve --flush-caches     # 旧版本写法
sudo nscd -i hosts                      # nscd
sudo systemctl restart dnsmasq          # dnsmasq
# 浏览器/应用侧连接池仍需重启，DNS 缓存与应用缓存是两回事
```

排查"为什么我这儿是新 IP、别人那儿是旧 IP"，`dig +noall +answer` 看 TTL 剩余值就够了，不必猜。

## 五、几个高价值排查习惯

1. **先 `getent` 后 `dig`**，顺序反了会浪费半小时。
2. **`dig +trace` 只在内网 DNS 无解时用**，它绕过配置直接问权威，能快速判定是"上游没配"还是"我这儿没收到"。
3. **抓包验证 UDP 53 是否被拦**：`tcpdump -i any -nn port 53`。云环境常见安全组只放通 TCP，UDP 被静默丢弃，表现为"解析偶尔超时"。
4. **大规模环境用 `dnsperf` 压一下递归服务器**，QPS 打满时的丢包与超时是另一类问题。

> 一句经验：**解析类问题先分成"根本没解析出来"和"解析出来了但慢"两堆**。前者查 hosts / nsswitch / 安全组；后者查 AAAA、search 域、ndots、递归服务器负载。分开之后，每一堆只剩两三个候选原因。
