---
title: 实验：Keepalived + Nginx 双机热备（含脑裂处理）
description: 用 VIP 实现秒级切换：keepalived 配置、健康检查脚本、脑裂的成因与防护，附可复现的验证步骤。
date: 2022-01-28
tags: [实验, Keepalived, 高可用, Nginx, VIP]
---

### 实验目标

两台 Nginx 前面挂一个虚拟 IP（VIP），任意一台宕机，VIP 在 1–3 秒内漂到另一台，客户端无感。

### 环境

| 节点 | IP | 角色 | 备注 |
| --- | --- | --- | --- |
| lb01 | 10.10.10.11 | MASTER | 优先级 100 |
| lb02 | 10.10.10.12 | BACKUP | 优先级 90 |
| VIP | 10.10.10.10 | 浮动 | 客户端访问这个 |
| web01/02 | 10.10.10.21/22 | 后端 | 提供 HTTP |

### 原理

keepalived 通过 VRRP 组播（默认协议 112）在局域网内选主：优先级高者为 MASTER，持续发心跳；BACKUP 收不到心跳就接管 VIP。

关键点：**VIP 只在一台机器上**，所以后端服务必须两台都跑（或用共享存储）。

### 步骤一：基础准备

```bash
# 两台
sudo dnf install -y nginx keepalived
sudo systemctl enable --now nginx

# 放行 VRRP（否则永远选不出主）
sudo firewall-cmd --add-rich-rule='rule protocol value="vrrp" accept' --permanent
sudo firewall-cmd --reload
```

**这一步最容易漏**。防火墙挡了 VRRP，两台都认为对方挂了，于是同时持有 VIP —— 就是脑裂。

### 步骤二：keepalived 配置

`/etc/keepalived/keepalived.conf`（lb01）：

```conf
global_defs {
    router_id lb01
    script_user root
    enable_script_security
}

vrrp_script chk_nginx {
    script "/etc/keepalived/chk_nginx.sh"
    interval 2
    weight -30
    fall 2
    rise 2
}

vrrp_instance VI_1 {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass Wt2026lab
    }
    virtual_ipaddress {
        10.10.10.10/24 dev eth0
    }
    track_script {
        chk_nginx
    }
    notify_mcast_group 224.0.0.18
}
```

lb02 只改三处：`router_id lb02`、`state BACKUP`、`priority 90`，其余必须**完全一致**（尤其 `virtual_router_id` 与 `auth_pass`）。

### 步骤三：健康检查脚本

```bash
sudo tee /etc/keepalived/chk_nginx.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
# Nginx 无响应或返回非 200，则判定异常
if curl -fsS -m 2 -o /dev/null http://127.0.0.1/healthz; then
  exit 0
fi
exit 1
EOF
sudo chmod 755 /etc/keepalived/chk_nginx.sh
```

`weight -30` 的含义：脚本失败时优先级 -30，MASTER 从 100 降到 70，低于 BACKUP 的 90 → 主动让位。

### 步骤四：启动与验证

```bash
sudo systemctl enable --now keepalived
sudo systemctl status keepalived

# 看 VIP 在哪台
ip addr show eth0 | grep 10.10.10.10
```

访问验证：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://10.10.10.10/
```

切换演练：

```bash
# 在 lb01 上停 keepalived
sudo systemctl stop keepalived
# 立刻在客户端连续探测
while true; do curl -s -o /dev/null -w '%{http_code} ' http://10.10.10.10/; sleep 0.3; done
```

预期：≤3 秒内恢复 200，期间可能出现 1–2 次超时。若出现长时间不可用，检查 VIP 是否已漂移（`ip addr` 于 lb02 上确认）。

### 步骤五：脑裂防护

脑裂 = 两台都认为自己是 MASTER，同时绑定 VIP。后果：ARP 冲突、流量错乱、数据不一致（若后面挂数据库）。

成因：

1. VRRP 组播被防火墙或交换机阻断。
2. 两台交换机隔离（不同 VLAN/不同物理网络）。
3. 网络分区（机房链路断）。

防护手段（按成本从低到高）：

**a) 第三方仲裁（推荐入门）**

在另一台机器上跑一个"见证"脚本，检测到两台同时持有 VIP 就告警并强制其中一台停 keepalived：

```bash
# 在监控机上，简单探测
for ip in 10.10.10.11 10.10.10.12; do
  ssh $ip "ip addr show eth0 | grep -q 10.10.10.10" && echo "$ip 持有 VIP"
done
```

两个都输出 → 立即告警（邮件/钉钉/短信）。

**b) 单播模式**

跨网段或组播不通时，改用单播，减少被阻断的概率：

```conf
vrrp_instance VI_1 {
    unicast_src_ip 10.10.10.11
    unicast_peer { 10.10.10.12 }
}
```

**c) 双心跳线**

管理网 + 业务网各跑一组 VRRP，任一组存活即可。

**d) fencing（企业级）**

用 IPMI/电源管理，检测到脑裂直接断电一台。粗暴但有效。

### 踩坑记录

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| VIP 不漂移 | 防火墙挡 VRRP | 放行 `protocol vrrp` |
| 两台都持有 VIP | 组播不通 + 无仲裁 | 单播 + 第三方仲裁 |
| 切过去又切回来 | 健康检查抖动（`fall/rise` 太小） | `fall 2 / rise 2` |
| VIP 起了但不通 | 交换机 MAC 表未更新 | 加 `garp_master_delay` 或用 arping |
| 重启后 VIP 在错的机器上 | `state` 写反且优先级未区分 | 优先看 `priority`，`state` 只是初始状态 |

### 结论

VIP 切换的本质是**"谁该持有这个地址"的共识**。keepalived 只解决共识的一半（网络可达性），另一半（防止双主）必须自己加仲裁。

上线前一定做三件事：演练切换、演练脑裂、把告警接上。没告警的高可用等于没有高可用。
