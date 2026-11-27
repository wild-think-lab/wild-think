---
title: iptables 与 firewalld 速查
summary: 四表五链的关系、常用规则模板、持久化与排错，以及"规则加了但不生效"的五个原因。
group: 网络
order: 3
tags: [iptables, 防火墙, 网络]
---

## 一、四表五链

```
表（做什么）：
  filter  允许/拒绝（默认）
  nat     地址转换
  mangle  改包内容（少见）
  raw     跳过连接跟踪（少见）

链（什么时候）：
  PREROUTING   进来但未路由
  INPUT        发往本机
  FORWARD      转发
  OUTPUT       本机发出
  POSTROUTING  发出前
```

**最常用的只有两个**：`filter` 表的 `INPUT` / `FORWARD`，`nat` 表的 `POSTROUTING`。

## 二、查看

```bash
iptables -L -n -v --line-numbers          # filter 表
iptables -t nat -L -n -v                 # nat 表
iptables-save                            # 完整规则（可备份）
iptables -S                              # 命令形式
```

## 三、常用规则

```bash
# 默认拒绝入向（先放通 SSH，否则锁死自己）
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -j ACCEPT
iptables -A INPUT -p tcp --dport 80,443 -j ACCEPT
iptables -P INPUT DROP
iptables -P FORWARD DROP

# 按来源限制
iptables -A INPUT -p tcp --dport 22 -s 203.0.113.0/24 -j ACCEPT

# 限速（防爆破：每分钟 5 次新连接）
iptables -A INPUT -p tcp --dport 22 -m conntrack --ctstate NEW \
  -m recent --set --name SSH
iptables -A INPUT -p tcp --dport 22 -m conntrack --ctstate NEW \
  -m recent --update --seconds 60 --hitcount 5 --name SSH -j DROP

# 端口转发（DNAT）
sysctl -w net.ipv4.ip_forward=1
iptables -t nat -A PREROUTING -p tcp --dport 8080 -j DNAT --to-destination 10.0.0.10:80
iptables -t nat -A POSTROUTING -j MASQUERADE

# 删除某条（先 --line-numbers 看编号）
iptables -D INPUT 3
```

## 四、firewalld（CentOS/RHEL 默认）

```bash
firewall-cmd --state
firewall-cmd --list-all
firewall-cmd --get-active-zones

# 放通服务/端口
firewall-cmd --add-service=http --add-service=https
firewall-cmd --add-port=8080/tcp
firewall-cmd --permanent --add-port=8080/tcp
firewall-cmd --reload

# 限制来源
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=203.0.113.0/24 port port=22 protocol=tcp accept'

# 端口转发
firewall-cmd --permanent --add-forward-port=port=8080:proto=tcp:toport=80:toaddr=10.0.0.10
```

**`--permanent` 与 `--reload` 的关系**：加 `--permanent` 只是写入配置，必须 `--reload` 才生效；不加 `--permanent` 是立即生效但重启丢失。

## 五、持久化

```bash
# iptables（Debian/Ubuntu）
apt install iptables-persistent
netfilter-persistent save

# 或手工
iptables-save > /etc/iptables/rules.v4

# firewalld 本身持久化
firewall-cmd --runtime-to-permanent
```

## 六、"规则加了但不生效"的五个原因

| 原因 | 检查 |
| --- | --- |
| 规则加在错误的位置（被前面的 ACCEPT 命中） | `iptables -L -n -v` 看每条的 pkts 计数 |
| 加在运行时但没持久化 | 重启后消失 |
| 云安全组在前面拦了 | 看云控制台的安全组规则 |
| 服务监听在 127.0.0.1 | `ss -tlnp`，防火墙管不到本机回环 |
| DOCKER 链覆盖了 | Docker 会在 filter 表插入自己的链，位置在 INPUT 之后 |

**Docker 的坑最典型**：`docker run -p 8080:80` 会自动改 iptables，绕过你的 INPUT 规则。

```bash
# 看 Docker 插入的规则
iptables -t nat -L DOCKER -n -v
# 阻止 Docker 改 iptables（需在 daemon.json 配置，且要自己管转发）
# "iptables": false
```

## 七、排错流程

```bash
# 1. 规则命中了没（看 pkts 列）
iptables -L INPUT -n -v --line-numbers

# 2. 包到没到本机
tcpdump -i eth0 -nn 'tcp port 8080'

# 3. 是否被 DROP
iptables -L -n -v | grep DROP

# 4. 加日志确认（调试用，注意别刷爆磁盘）
iptables -I INPUT -p tcp --dport 8080 -j LOG --log-prefix 'DBG8080: '
journalctl -k | grep DBG8080
```

**加日志是最快的定位手段**：能看到包有没有到、被哪条规则处理。

## 八、安全基线

```
□ 默认策略 INPUT DROP、FORWARD DROP
□ 放通 lo 与 ESTABLISHED
□ SSH 只对白名单开放
□ 数据库/缓存端口不对公网
□ 有防爆破限速
□ 规则持久化（重启不丢）
□ 变更前备份 iptables-save
```
