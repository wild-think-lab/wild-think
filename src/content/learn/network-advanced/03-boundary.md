---
title: 边界：NAT、防火墙与"为什么外面访问不到"
module: 熟练篇
summary: SNAT/DNAT 的区别、端口映射的写法、防火墙默认策略，以及"映射了还是访问不到"的四层排查。
minutes: 30
---

### 两种 NAT，方向相反

```
SNAT（源地址转换）：内网出去时改写源 IP（让内网能上网）
DNAT（目的地址转换）：外部进来时改写目的 IP（端口映射）
```

**同一个出口，两个方向都要配**：

```
内 → 外：SNAT（或 MASQUERADE）
外 → 内：DNAT + 放行 + 回程
```

### SNAT 的写法

```bash
# iptables
iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o eth0 -j MASQUERADE

# nftables
nft add rule ip nat postrouting oifname "eth0" ip saddr 10.0.0.0/24 masquerade
```

**`MASQUERADE` 与 `SNAT --to` 的区别**：

```
MASQUERADE：自动取出口 IP（适合动态 IP）
SNAT：写死一个 IP（性能略好，适合固定 IP）
```

### DNAT（端口映射）

```bash
iptables -t nat -A PREROUTING -p tcp --dport 8080 -j DNAT --to-destination 10.0.0.10:80
```

**"外部访问 8080 → 内部 80"** 就是这样一条。

**别忘了放行**（有些实现里 NAT 之后仍要 filter 放行）。

### 防火墙默认策略

```
默认拒绝（deny）→ 只开必要端口
默认放行（allow）→ 等于没有防火墙
```

```bash
firewall-cmd --set-default-zone=drop
firewall-cmd --permanent --add-service=ssh
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
```

**"先设默认 drop 再逐个放行"** 顺序错了会把自己关在外面。

### 四层排查"映射了还是访问不到"

```
① 端口真的在监听吗
   ss -lntp | grep 8080

② 本机能访问吗
   curl -v http://127.0.0.1:8080/

③ 内网其他机器能访问吗（不经 NAT）
   curl -v http://10.0.0.10:80/

④ 经过 NAT 能访问吗
   curl -v http://<公网IP>:8080/
```

**"①②通、③通、④不通"** → 问题一定在 NAT/安全组/云平台侧。

**"③就不通"** → 服务监听在 127.0.0.1 而不是 0.0.0.0。

**"服务只听 127.0.0.1"** 是"端口映射失败"的最常见原因之一。

### 云环境多一层"安全组"

```
云上：安全组（平台层）+ 主机防火墙（系统层）
两层都要放行
```

**"安全组开了、主机防火墙也开了，还是不通"** → 检查是否"回程被安全组拦"或"NAT 网关不在同一 VPC"。

### 反向代理与"真实 IP"

```
经过 nginx 后，后端看到的源 IP 是 nginx 的 IP
→ 需要 X-Forwarded-For + real_ip 模块
```

```nginx
set_real_ip_from 10.0.0.0/24;
real_ip_header X-Forwarded-For;
```

**"日志里全是 127.0.0.1 / 内网 IP"** → 没配 real_ip。

### 一个"对外发布服务"的 checklist

```
□ 服务监听 0.0.0.0（不是 127.0.0.1）
□ 主机防火墙放行
□ 云安全组放行
□ DNAT/端口映射正确（含回程）
□ 有 TLS（不要裸 HTTP 对外）
□ 有访问日志与限流
□ 有健康检查
□ 不直接暴露管理端口（22/3306/6379）
```

### 小结

```
① SNAT 出去，DNAT 进来，两个方向都要配
② 默认拒绝 + 白名单
③ 排查按"监听 → 本机 → 内网 → 公网"四步
④ 云上多一层安全组
⑤ 代理后要配 real_ip
```
